"""Offline tool routing, provider streams and IPC lifecycle; no model/server startup."""
import asyncio
import copy
import json
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

import httpx

from studio.core.utils.interax.component import BridgeError, Interax
from studio.core.utils.interax.initialize import Settings, check, configuration
from studio.core.utils.llm.tools import ToolLoop
from voicemem.reply import deepseek_reply, openai_reply, reply_request_options, reply_tool_handler


class FakeBridge:
    def __init__(self):
        self.calls = []

    async def describe(self):
        return {"catalog": [{"key": name, "help": "upstream help", "example": {}}
                            for name in ("createSession", "submit", "poll")],
                "skills": [{"name": "future-skill", "description": "A new upstream capability"}]}

    async def execute(self, method, parameters):
        self.calls.append((method, parameters))
        return {"sessionId": "fixture_session", "progress": {"stage": "completed"},
                "results": [{"summary": "Verified backend result"}]}


def tool_events(method="submit", *, index=0):
    arguments = json.dumps({"method": method, "parameters": {
        "text": "fixture", "skills": ["future-skill"]} if method == "submit" else {}})
    return [
        ("reasoning", "private reasoning"),
        ("tool_calls", [{"index": index, "id": "call_fixture", "function": {"name": "sdk", "arguments": arguments[:18]}}]),
        ("tool_calls", [{"index": index, "function": {"arguments": arguments[18:]}}]),
        ("finish", "tool_calls"),
    ]


def sse(events):
    output = []
    for kind, value in events:
        choice = {"delta": {}, "index": 0}
        if kind == "finish":
            choice["finish_reason"] = value
        else:
            choice["delta"][{"reasoning": "reasoning_content"}.get(kind, kind)] = value
        output.append("data: " + json.dumps({"id": "fixture", "object": "chat.completion.chunk",
                                            "created": 0, "model": "fixture", "choices": [choice]}) + "\n\n")
    return ("".join(output) + "data: [DONE]\n\n").encode()


class ToolTests(unittest.IsolatedAsyncioTestCase):
    async def test_remote_providers_roundtrip_split_tool_arguments_and_results(self):
        for protocol in ("deepseek", "qwen", "openai"):
            with self.subTest(protocol=protocol):
                bridge = FakeBridge()
                requests = []
                bodies = [sse(tool_events("createSession")), sse(tool_events()),
                          sse([("content", "温和|真实结果。"), ("finish", "stop")])]

                def handle(request):
                    requests.append(json.loads(request.content))
                    return httpx.Response(200, content=bodies[len(requests) - 1],
                                          headers={"content-type": "text/event-stream"})

                original = httpx.AsyncClient
                clients = []

                class Client(original):
                    def __init__(self, **kwargs):
                        super().__init__(transport=httpx.MockTransport(handle), **kwargs)
                        clients.append(self)

                with patch("httpx.AsyncClient", Client):
                    if protocol == "openai":
                        from openai import AsyncOpenAI
                        def sdk(**kwargs):
                            return AsyncOpenAI(http_client=Client(), **kwargs)
                        with patch("openai.AsyncOpenAI", side_effect=sdk):
                            provider = openai_reply(model="fixture", api_key="test-only", base_url="https://provider.invalid/v1", system="persona")
                            with reply_tool_handler(ToolLoop(bridge)):
                                result = [delta async for delta in provider("request", "memory", [])]
                    else:
                        provider = deepseek_reply(model="fixture", api_key="test-only", base_url="https://provider.invalid/v1", protocol=protocol)
                        with reply_request_options(reasoning_effort="high"), reply_tool_handler(ToolLoop(bridge)):
                            result = [delta async for delta in provider("request", "memory", [])]
                        await provider.aclose()
                for active in clients:
                    await active.aclose()
                self.assertEqual(result, ["温和|真实结果。"])
                self.assertEqual([name for name, _ in bridge.calls], ["createSession", "submit"])
                self.assertEqual(bridge.calls[1][1]["skills"], ["future-skill"])
                self.assertEqual(requests[0]["tools"][0]["function"]["name"], "sdk")
                self.assertIn("future-skill", requests[0]["messages"][-1]["content"])
                self.assertEqual(requests[1]["messages"][-1]["role"], "tool")
                self.assertIn("Verified backend result", requests[1]["messages"][-1]["content"])
                self.assertEqual(requests[1]["messages"][-2]["reasoning_content"], "private reasoning")
                self.assertFalse(requests[0]["parallel_tool_calls"])
                if protocol == "qwen":
                    self.assertTrue(requests[0]["enable_thinking"])
                    self.assertNotIn("thinking", requests[0])
                if protocol == "deepseek":
                    self.assertEqual(requests[0]["thinking"], {"type": "enabled"})

    async def test_duplicate_submit_becomes_tool_error_without_reexecution(self):
        bridge = FakeBridge()
        requests = []

        async def events(request):
            requests.append(copy.deepcopy(request))
            data = tool_events() if len(requests) < 3 else [("content", "Already submitted"), ("finish", "stop")]
            for event in data:
                yield event

        output = [text async for text in ToolLoop(bridge)({"messages": []}, events)]
        self.assertEqual(output, ["Already submitted"])
        self.assertEqual(len(bridge.calls), 1)
        self.assertIn("already attempted", requests[-1]["messages"][-1]["content"])

    async def test_incomplete_or_truncated_tool_arguments_never_execute(self):
        for finish in ("length", None):
            bridge = FakeBridge()
            async def events(request):
                for event in tool_events()[:-1]:
                    yield event
                if finish:
                    yield "finish", finish
            with self.assertRaisesRegex(RuntimeError, "Incomplete tool"):
                _ = [text async for text in ToolLoop(bridge)({"messages": []}, events)]
            self.assertFalse(bridge.calls)

    async def test_budget_forces_final_answer_and_does_not_mutate_input_history(self):
        bridge = FakeBridge()
        original = {"messages": [{"role": "system", "content": "persona"}]}
        requests = []
        async def events(request):
            requests.append(copy.deepcopy(request))
            data = tool_events("poll") if len(requests) < 8 else [("content", "Progress checked"), ("finish", "stop")]
            for event in data:
                yield event
        self.assertEqual([text async for text in ToolLoop(bridge)(original, events)], ["Progress checked"])
        self.assertEqual(len(bridge.calls), 7)
        self.assertEqual(requests[-1]["tool_choice"], "none")
        self.assertEqual(original, {"messages": [{"role": "system", "content": "persona"}]})

    async def test_deepseek_tool_stream_cancel_releases_http_body(self):
        waiting = asyncio.Event()
        closed = asyncio.Event()
        class Body(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield sse(tool_events()[:2]).removesuffix(b"data: [DONE]\n\n")
                waiting.set()
                await asyncio.Event().wait()
            async def aclose(self):
                closed.set()
        original = httpx.AsyncClient
        def client(**kwargs):
            return original(transport=httpx.MockTransport(lambda _: httpx.Response(200, stream=Body())), **kwargs)
        bridge = FakeBridge()
        with patch("httpx.AsyncClient", side_effect=client):
            provider = deepseek_reply(api_key="test-only")
            async def run():
                with reply_tool_handler(ToolLoop(bridge)):
                    return [text async for text in provider("request")]
            task = asyncio.create_task(run())
            await asyncio.wait_for(waiting.wait(), 1)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertTrue(closed.is_set())
            self.assertFalse(bridge.calls)
            await provider.aclose()

    async def test_cancel_during_model_stream_closes_without_executing(self):
        bridge = FakeBridge()
        waiting = asyncio.Event()
        closed = asyncio.Event()
        async def events(request):
            try:
                yield tool_events()[1]
                waiting.set()
                await asyncio.Event().wait()
            finally:
                closed.set()
        async def run():
            return [text async for text in ToolLoop(bridge)({"messages": []}, events)]
        task = asyncio.create_task(run())
        await asyncio.wait_for(waiting.wait(), 1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(closed.is_set())
        self.assertFalse(bridge.calls)

    async def test_space_change_discards_call_and_no_tools_fallback_is_honest(self):
        bridge = FakeBridge()
        current = True
        async def events(request):
            nonlocal current
            for event in tool_events():
                current = False
                yield event
        with self.assertRaises(asyncio.CancelledError):
            _ = [text async for text in ToolLoop(bridge, lambda: current)({"messages": []}, events)]
        self.assertFalse(bridge.calls)
        bridge.describe = AsyncMock(side_effect=BridgeError({"code": "unavailable"}))
        async def fallback(request):
            self.assertNotIn("tools", request)
            self.assertIn("不可用", request["messages"][-1]["content"])
            yield "content", "Unavailable"
        self.assertEqual([text async for text in ToolLoop(bridge)({"messages": []}, fallback)], ["Unavailable"])


class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_tool_reply_error_does_not_instruct_duplicate_submission(self):
        from studio.core.utils.reply.component import Reply
        agent = SimpleNamespace(vm=object(), ACTIVE_SPACE="fixture",
                                _send_reply_display=AsyncMock(),
                                _voicemem_llm_tts=AsyncMock(side_effect=RuntimeError("provider failed")))
        send = AsyncMock()
        with reply_tool_handler(object()):
            with self.assertRaises(RuntimeError):
                await Reply.voicemem_llm_tts(agent, SimpleNamespace(), send, AsyncMock(), {},
                                            SimpleNamespace(output_id="fixture"))
        message = send.await_args.args[0]["message"]
        self.assertIn("可能已经提交", message)
        self.assertNotIn("重试", message)

    async def test_cancelled_ipc_call_is_drained_before_next_command(self):
        bridge = Interax(None)
        entered = asyncio.Event()
        release = asyncio.Event()
        commands = []
        async def operation(message):
            commands.append(message["op"])
            if message["op"] == "submit":
                entered.set()
                await release.wait()
                bridge.last_operation = {"accepted": True}
            return message["op"]
        bridge._operation = operation
        first = asyncio.create_task(bridge.call({"op": "submit"}))
        await entered.wait()
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        second = asyncio.create_task(bridge.call({"op": "poll"}))
        await asyncio.sleep(0)
        self.assertEqual(commands, ["submit"])
        release.set()
        self.assertEqual(await second, "poll")
        self.assertEqual(bridge.last_operation, {"accepted": True})
        await bridge.aclose()

    async def test_real_node_ipc_initialize_dispose_without_backend(self):
        root = Path(__file__).resolve().parents[2] / "Interax"
        bridge = Interax(Settings("https://interax.invalid/", root))
        await bridge._start()
        process = bridge.process
        await bridge.aclose()
        self.assertIsNotNone(process.returncode)
        self.assertTrue(bridge.closed)
        with self.assertRaises(BridgeError):
            await bridge.call({"op": "describe"})

    async def test_enabled_conversation_suppresses_speculative_reply(self):
        from studio.core.utils.conversation.component import Conversation
        session = SimpleNamespace(interax_settings=object())
        refined = asyncio.create_task(asyncio.Event().wait())
        await Conversation.start_early(session, "partial", None, refined_text=refined)
        self.assertTrue(refined.cancelled())

    async def test_disconnect_reaps_pending_ipc_without_cancelling_backend(self):
        bridge = Interax(None)
        entered = asyncio.Event()
        async def operation(message):
            entered.set()
            await asyncio.Event().wait()
        bridge._operation = operation
        task = asyncio.create_task(bridge.call({"op": "execute"}))
        await entered.wait()
        await bridge.aclose()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertIsNone(bridge.pending)

    async def test_conversation_foreground_uses_tools_but_filler_does_not(self):
        from studio.core.utils.conversation.component import Conversation
        from studio.core.utils.contracts.component import Pending
        from studio.core.utils.turn_taking.initialize import HandoffKind
        from voicemem.reply import _TOOL_HANDLER
        settings = Settings("https://interax.invalid/", Path("unused"))
        seen = []
        async def reply(*args, **kwargs):
            seen.append(_TOOL_HANDLER.get())
        agent = SimpleNamespace(ACTIVE_SPACE="space_a", vm=object(), BARGE_DEBUG=False,
                                voicemem_llm_tts=reply, _push_history=Mock(return_value="turn"),
                                queue_remember_turn=Mock())
        session = SimpleNamespace(
            agent=agent, interax_settings=settings, interax_sessions={}, early={"task": None},
            drop_early=AsyncMock(), speech_rate=None, reset_output_state=Mock(), context_session="socket_one",
            owner={}, sock=SimpleNamespace(send_json=AsyncMock()), send_audio=AsyncMock(),
            turn={}, cached_ack=Mock(return_value=None), reply_done=lambda task: task.exception(),
            turn_taking=SimpleNamespace(decide_handoff=lambda **kwargs: SimpleNamespace(kind=HandoffKind.DIRECT),
                                       start_handoff=Mock(), start_reply=Mock(), finish_reply=Mock()))
        session.watch_interax_pages = Mock()
        pending = Pending("request", "", None)
        for space in ("space_a", "space_b", "space_a"):
            agent.ACTIVE_SPACE = space
            routing = asyncio.create_task(asyncio.sleep(0))
            await Conversation.start_reply(session, pending, routing)
            await session.turn["task"]
        self.assertIsInstance(seen[0], ToolLoop)
        self.assertIsNot(seen[0].bridge, seen[1].bridge)
        self.assertIs(seen[0].bridge, seen[2].bridge)
        self.assertIsNone(_TOOL_HANDLER.get())
        pending.stranger = True
        await Conversation.start_reply(session, pending, asyncio.create_task(asyncio.sleep(0)))
        await session.turn["task"]
        self.assertIsNone(seen[-1])
        for bridge in session.interax_sessions.values():
            await bridge.aclose()


class PageDeliveryTests(unittest.IsolatedAsyncioTestCase):
    def conversation(self):
        from studio.core.utils.conversation.component import Conversation
        session = Conversation.__new__(Conversation)
        session.agent = SimpleNamespace(ACTIVE_SPACE="space_a")
        session.sock = SimpleNamespace(send_json=AsyncMock())
        session.interax_sessions = {"space_a": SimpleNamespace(page_action=AsyncMock(return_value={"documents": []}))}
        return session

    async def test_browser_actions_preserve_scope_and_do_not_block_capture(self):
        session = self.conversation()
        bridge = session.interax_sessions["space_a"]
        release = asyncio.Event()
        entered = asyncio.Event()
        async def action(*args, **kwargs):
            entered.set()
            await release.wait()
            return {"documents": [{"content": "<html>fixture</html>"}]}
        bridge.page_action.side_effect = action
        data = {"space": "space_a", "token": "selected", "action": "openPage", "page": {"itemId": "one"}}
        await session.interax_page_action(data)
        await entered.wait()
        self.assertFalse(session.interax_action_task.done())
        await session.interax_page_action({**data, "space": "space_b"})
        self.assertFalse(session.sock.send_json.await_args.args[0]["ok"])
        self.assertEqual(bridge.page_action.await_count, 1)
        release.set()
        await session.interax_action_task
        result = session.sock.send_json.await_args.args[0]
        self.assertTrue(result["ok"])
        self.assertEqual(result["token"], "selected")
        self.assertIn("fixture", result["result"]["documents"][0]["content"])

    async def test_stale_result_and_page_failures_are_not_confirmations(self):
        session = self.conversation()
        bridge = session.interax_sessions["space_a"]
        async def changed(*args, **kwargs):
            session.agent.ACTIVE_SPACE = "space_b"
            return {}
        bridge.page_action.side_effect = changed
        await session.interax_page_action({"space": "space_a", "token": "one", "action": "confirmPage"})
        await session.interax_action_task
        session.sock.send_json.assert_not_awaited()
        session.agent.ACTIVE_SPACE = "space_a"
        bridge.page_action.side_effect = BridgeError({"code": "stale_presentation"})
        await session.interax_page_action({"space": "space_a", "token": "one", "action": "confirmPage"})
        await session.interax_action_task
        result = session.sock.send_json.await_args.args[0]
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "stale_presentation")

    async def test_late_pages_are_deduplicated_and_revisions_delivered(self):
        session = self.conversation()
        bridge = session.interax_sessions["space_a"]
        bridge.process = object()
        bridge.failed = bridge.closed = False
        first = [{"itemId": "one", "revision": 1}]
        revised = [{"itemId": "one", "revision": 2}]
        bridge.pages = AsyncMock(side_effect=[[], first, first, revised])
        finished = asyncio.Event()
        calls = 0
        async def tick(_):
            nonlocal calls
            calls += 1
            if calls > 4:
                finished.set()
                await asyncio.Event().wait()
        with patch("studio.core.utils.conversation.component.asyncio.sleep", side_effect=tick):
            session.watch_interax_pages("space_a", bridge)
            await finished.wait()
            task = session.interax_watchers["space_a"]
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        events = [call.args[0] for call in session.sock.send_json.await_args_list]
        self.assertEqual([event["pages"] for event in events], [[], first, revised])
        self.assertTrue(all(event["space"] == "space_a" for event in events))

    async def test_page_ipc_uses_dedicated_operations(self):
        bridge = Interax(None)
        bridge.call = AsyncMock(return_value={})
        await bridge.page_action("confirmPage", token="one")
        bridge.call.assert_awaited_with({"op": "confirmPage", "token": "one"})
        with self.assertRaises(ValueError):
            await bridge.page_action("execute", token="one")

    async def test_disconnect_reaps_page_watchers_and_actions(self):
        session = self.conversation()
        session.prewarm = {"closed": False}
        session.stop_prewarm = Mock()
        session.drop_early = AsyncMock()
        session.turn = {"task": None}
        watcher = asyncio.create_task(asyncio.Event().wait())
        action = asyncio.create_task(asyncio.Event().wait())
        session.interax_watchers = {"space_a": watcher}
        session.interax_action_task = action
        bridge = session.interax_sessions["space_a"]
        bridge.aclose = AsyncMock()
        await session.close_session()
        self.assertTrue(watcher.cancelled())
        self.assertTrue(action.cancelled())
        bridge.aclose.assert_awaited_once()
        self.assertEqual(session.interax_sessions, {})


class ConfigurationTests(unittest.TestCase):
    def test_opt_in_url_and_unsupported_provider(self):
        with patch.dict(os.environ, {"STUDIO_INTERAX_BASE_URL": ""}):
            self.assertIsNone(configuration())
        for value in ("file:///tmp", "https://user:secret@host/", "https://host/?secret=x"):
            with patch.dict(os.environ, {"STUDIO_INTERAX_BASE_URL": value}):
                with self.assertRaises(ValueError):
                    configuration()
        settings = Settings("https://host/proxy/", Path("unused"))
        for mode, provider in (("realtime", "openai"), ("llm_tts", "local")):
            with self.assertRaises(ValueError):
                check(settings, mode=mode, provider=provider)


if __name__ == "__main__":
    unittest.main()
