"""Deterministic scheduler, inbox and reply-entry regressions; no paid providers."""
import asyncio
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from studio.core.utils.interax.events import ExternalEvent, bounded_data
from studio.core.utils.interax.initialize import Settings
from studio.core.utils.interax.scheduler import Journal, Schedule, Scheduler, encode


class Clock:
    now = 1000.0
    def __call__(self):
        return self.now


class FakeBridge:
    failed = closed = False
    def __init__(self, settings):
        self.events = {}
        self.states = {}
        self.calls = []
    async def call(self, message):
        self.calls.append(message)
        if message['op'] == 'restore':
            return True
        sid, after = message['sessionId'], message['after']
        records = [e for e in self.events.get(sid, []) if e['seq'] > after][:100]
        return {'updates': records, 'next_cursor': records[-1]['seq'] if records else after,
                'has_more': False, 'snapshot': self.states[sid]}
    async def aclose(self):
        self.closed = True


class Subscriber:
    def __init__(self, chat='chat', space='space'):
        self.chat, self.space, self.busy = chat, space, False
        self.seen, self.states = [], []
        self.failures = 0
    def ready(self):
        return not self.busy
    async def publish(self, value):
        self.states.append(value)
    async def consume(self, identity, data, service):
        if self.failures:
            self.failures -= 1
            raise RuntimeError('injected provider failure')
        self.seen.append(data)
        await service.commit_model(identity, self.chat, self.space, data['session_id'], 'Verified result')


class SchedulerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.clock = Clock()
        self.settings = Settings('http://fixture.invalid/', Path(__file__).resolve().parents[2] / 'Interax',
                                 Path(self.temp.name) / 'scheduler.sqlite')
        self.service = Scheduler(self.settings, clock=self.clock, bridge_factory=FakeBridge)
        self.service.journal = Journal(self.settings.state_path)
        self.sub = Subscriber()
        self.service.subscribers[('chat', 'space')] = self.sub

    async def asyncTearDown(self):
        await self.service.close()
        self.temp.cleanup()

    async def bind(self, sid='one', config=None, stage='completed', kind='execution.completed', chat='chat', space='space'):
        await self.service.journal.execute('INSERT INTO bindings(sid,chat,space,config) VALUES (?,?,?,?)',
                                           (sid, chat, space, encode((config or Schedule()).__dict__)))
        bridge = await self.service.bridge(chat, space)
        bridge.events[sid] = [{'seq': 1, 'event_id': sid + '-e1', 'version': 1,
                               'session_id': sid, 'kind': kind, 'payload': {'request_id': 'request-' + sid}}]
        bridge.states[sid] = {'sessionId': sid, 'cursor': 1, 'execution': stage, 'goal': sid,
                              'requests': [{'id': 'request-' + sid, 'stage': stage}], 'items': [], 'questions': []}
        return bridge

    async def tick(self):
        await self.service.tick()
        await asyncio.gather(*self.service.consumers.values())

    async def test_ordinary_chat_has_no_backend_binding_or_poll(self):
        await self.tick()
        self.assertFalse(self.service.bridges)
        self.assertEqual(self.sub.seen, [])

    async def test_online_ready_automatically_delivers_without_poll_tool(self):
        await self.bind(stage='running', kind='interaction.ready')
        await self.tick()
        self.assertEqual(self.sub.seen[0]['status'], 'running')
        rows = await self.service.journal.rows('SELECT state FROM inbox')
        self.assertEqual(rows[0]['state'], 'consumed')

    async def test_background_clock_wakes_during_silence_with_true_running_state(self):
        await self.bind(config=Schedule('background', 60, 1005, 'completed'), stage='running', kind='execution.running')
        await self.tick()
        self.assertFalse(self.sub.seen)
        self.clock.now = 1005
        await self.tick()
        self.assertEqual(self.sub.seen[0]['reason'], 'scheduled_check')
        self.assertEqual(self.sub.seen[0]['status'], 'running')
        self.clock.now += 60
        await self.tick()
        self.assertEqual(len(self.sub.seen), 1)

    async def test_delayed_completion_and_timer_race_deliver_once(self):
        await self.bind(config=Schedule('background', 30, 1010, 'at_wake'))
        await self.tick()
        self.assertFalse(self.sub.seen)
        self.assertEqual(self.sub.states[-1]['tasks'][0]['stage'], 'completed')
        self.clock.now = 1010
        await self.tick()
        await self.tick()
        self.assertEqual(len(self.sub.seen), 1)

    async def test_user_speech_generation_and_tts_gate_only_model_delivery(self):
        await self.bind()
        self.sub.busy = True
        await self.tick()
        self.assertTrue(self.sub.states[-1]['tasks'])
        self.assertFalse(self.sub.seen)
        self.sub.busy = False
        await self.tick()
        self.assertEqual(len(self.sub.seen), 1)

    async def test_retry_after_fetch_failure_keeps_inbox_and_deduplicates(self):
        await self.bind()
        self.sub.failures = 1
        await self.tick()
        rows = await self.service.journal.rows('SELECT state FROM inbox')
        self.assertEqual(rows[0]['state'], 'queued')
        self.clock.now += 5
        await self.tick()
        self.clock.now += 5
        await self.tick()
        self.assertEqual(len(self.sub.seen), 1)
        self.assertEqual(len(await self.service.journal.rows('SELECT * FROM inbox')), 1)

    async def test_multiple_sessions_and_spaces_are_isolated(self):
        await self.bind('two')
        await self.bind('one')
        await self.bind('private', space='other')
        await self.tick()
        await self.tick()
        self.assertEqual({d['session_id'] for d in self.sub.seen}, {'one', 'two'})

    async def test_required_question_overrides_background_delay(self):
        await self.bind(config=Schedule('background', 30, 2000, 'at_wake'), stage='waiting', kind='interaction.question')
        await self.tick()
        self.assertEqual(self.sub.seen[0]['status'], 'waiting')

    async def test_stop_waiting_keeps_task_and_resume_delivers(self):
        bridge = await self.bind()
        await self.service.control('chat', 'space', 'one', 'stop_waiting')
        await self.tick()
        self.assertFalse(self.sub.seen)
        self.assertFalse(any(c.get('method') == 'cancel' for c in bridge.calls))
        await self.service.control('chat', 'space', 'one', 'resume_waiting')
        await self.tick()
        self.assertEqual(len(self.sub.seen), 1)

    async def test_disconnect_and_restart_keep_inbox_without_resubmitting(self):
        await self.bind()
        self.service.detach('chat', 'space', self.sub)
        await self.tick()
        self.assertFalse(self.sub.seen)
        await self.service.close()
        self.service = Scheduler(self.settings, clock=self.clock, bridge_factory=FakeBridge)
        self.service.journal = Journal(self.settings.state_path)
        self.service.subscribers[('chat', 'space')] = self.sub
        await self.tick()
        self.assertEqual(len(self.sub.seen), 1)
        self.assertFalse(self.service.bridges)

    async def test_summary_budget_keeps_identity_status_and_original_record(self):
        bridge = await self.bind()
        bridge.states['one']['items'] = [{'id': str(i), 'revision': i, 'summary': 'x' * 20000, 'validity': 'current'} for i in range(30)]
        await self.tick()
        value = bounded_data(self.sub.seen[0])
        self.assertLessEqual(len(json.dumps(value, ensure_ascii=False)), 12000)
        self.assertEqual(value['status'], 'completed')
        self.assertEqual(value['covered_cursor'], 1)
        self.assertTrue(await self.service.journal.rows('SELECT payload FROM inbox'))

    async def test_invalid_schedules_and_foreign_controls_rejected(self):
        for config in ({'poll_interval': 0}, {'delay': -1}, {'wake_at': float('nan')}, {'delivery_policy': 'at_wake'}):
            with self.assertRaises(ValueError):
                Schedule.parse(config, self.clock())
        await self.bind()
        with self.assertRaises(ValueError):
            await self.service.control('other-chat', 'space', 'one', 'cancel')

    async def test_pagination_defers_latest_snapshot_and_coalesces_old_ready_events(self):
        bridge = await self.bind()
        first = bridge.events['one'][0]
        bridge.events['one'] = [{**first, 'seq': i, 'event_id': f'e{i}', 'kind': 'interaction.ready'}
                                for i in range(1, 151)]
        bridge.states['one']['cursor'] = 150
        original = bridge.call
        async def page(message):
            value = await original(message)
            if message['op'] == 'updates':
                value['has_more'] = value['next_cursor'] < 150
            return value
        bridge.call = page
        await self.tick()
        self.assertFalse(self.sub.seen)
        await self.tick()
        await self.tick()
        self.assertEqual(len(self.sub.seen), 1)
        self.assertEqual(self.sub.seen[0]['covered_cursor'], 150)
        self.assertEqual(len(await self.service.journal.rows("SELECT id FROM inbox WHERE state='consumed'")), 150)

    async def test_control_invalidates_inflight_poll_and_close_reaps_pollers(self):
        bridge = await self.bind()
        entered, release = asyncio.Event(), asyncio.Event()
        original = bridge.call
        async def delayed(message):
            if message['op'] == 'updates':
                entered.set()
                await release.wait()
            return await original(message)
        bridge.call = delayed
        await self.service.tick(wait_polls=False)
        await entered.wait()
        await self.service.control('chat', 'space', 'one', 'stop_waiting')
        release.set()
        await asyncio.gather(*self.service.pollers.values())
        self.assertEqual((await self.service.journal.rows('SELECT cursor FROM bindings'))[0]['cursor'], 0)
        release.clear()
        await self.service.tick(wait_polls=False)
        tasks = list(self.service.pollers.values())
        await self.service.close()
        self.service.journal = None
        self.assertTrue(all(task.done() for task in tasks))

    async def test_oversized_question_fields_are_bounded_without_mutating_records(self):
        data = {'session_id': 'one', 'status': 'waiting', 'summary_version': 7, 'covered_cursor': 91,
                'questions': [{'payload': {'text': 't' * 50000, 'choices': ['c' * 20000] * 100}}] * 8}
        result = bounded_data(data)
        self.assertLessEqual(len(json.dumps(result, ensure_ascii=False)), 12000)
        self.assertEqual(result['covered_cursor'], 91)
        self.assertEqual(len(data['questions'][0]['payload']['text']), 50000)


class ReplyEntryTests(unittest.IsolatedAsyncioTestCase):
    async def test_actual_provider_and_tts_entry_no_user_memory_or_tool_side_effect(self):
        from evals.test_reply_text import ShortReplyTextTests
        from studio.core.utils.conversation.component import Conversation
        from studio.core.utils.session_context.component import SessionBuffer
        from voicemem.reply import deepseek_reply
        import httpx
        fixture = ShortReplyTextTests()
        fixture.setUp()
        agent = fixture.agent
        agent._SESSION_CONTEXT = SessionBuffer()
        agent.BC_ECHO_WINDOW_S = 2
        agent.MIC_RATE = 24000
        requests = []
        original = httpx.AsyncClient
        def request(req):
            requests.append(json.loads(req.content))
            chunks = [{'choices': [{'delta': {'content': '温和|页面已经生成。'}, 'finish_reason': None}]},
                      {'choices': [{'delta': {}, 'finish_reason': 'stop'}]}]
            return httpx.Response(200, text=''.join('data: ' + json.dumps(c) + '\n\n' for c in chunks) + 'data: [DONE]\n\n')
        with patch('httpx.AsyncClient', lambda **kwargs: original(transport=httpx.MockTransport(request), **kwargs)):
            provider = deepseek_reply(model='fixture', api_key='test-only', base_url='https://fixture.invalid/v1')
            agent.vm.reply_stream = provider
            service = SimpleNamespace(commit_model=AsyncMock(), journal=SimpleNamespace(execute=AsyncMock()))
            agent.task_scheduler = service
            socket = SimpleNamespace(query_params={}, send_bytes=AsyncMock(), send_json=AsyncMock())
            with patch('studio.core.utils.interax.initialize.configuration', return_value=None):
                conversation = Conversation(agent, socket)
            async def send(message):
                fixture.messages.append(message)
                if message['type'] == 'answer_done':
                    timeline = conversation.turn['timeline']
                    timeline.update_checkpoint(timeline.sent_samples, 24000, 'drained')
            socket.send_json = send
            await conversation.consume('event-identity', {'session_id': 'task-one', 'status': 'completed', 'summary_version': 2}, service)
            await provider.aclose()
        self.assertEqual(service.commit_model.await_count, 1)
        self.assertTrue(fixture.tts_text)
        socket.send_bytes.assert_awaited()
        self.assertFalse(agent.queue_remember_turn.called)
        self.assertFalse(any(m['type'] == 'user_transcript' for m in fixture.messages))
        self.assertFalse(any(m['role'] in {'user', 'tool'} for m in requests[0]['messages']))
        self.assertNotIn('tools', requests[0])
        self.assertIn('task-one', requests[0]['messages'][-1]['content'])
        self.assertEqual(requests[0]['messages'][-1]['role'], 'assistant')

    async def test_external_failure_never_commits_partial_output(self):
        commit = AsyncMock()
        async def events(request):
            yield 'content', 'partial'
            raise RuntimeError('fixture failure')
        with self.assertRaises(RuntimeError):
            _ = [text async for text in ExternalEvent('one', {}, commit)({'messages': [{'role': 'user', 'content': ''}]}, events)]
        commit.assert_not_awaited()


if __name__ == '__main__':
    unittest.main()
