"""Actual SDK/HTTP/scheduler/reply/UI loop with offline model and TTS doubles.

Run with a dedicated port: python -m uvicorn evals.serve_task_loop_fixture:app --port 8792
All databases live in TemporaryDirectory; no credentials or user spaces are loaded.
"""
import asyncio
from contextlib import asynccontextmanager
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
from unittest.mock import Mock, patch

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from langchain_core.messages import AIMessage

from interax_harness.api import create_app
from interax_harness.config import Settings as BackendSettings
from studio.core.utils.conversation.component import Conversation
from studio.core.utils.contracts.component import Pending
from studio.core.utils.interax.initialize import Settings
from studio.core.utils.interax.scheduler import Scheduler
from studio.core.utils.session_context.component import SessionBuffer
from evals.test_reply_text import ShortReplyTextTests


ROOT = Path(__file__).resolve().parents[1]
UPSTREAM = ROOT.parent / 'Interax'
observed = {'model_requests': [], 'browser_receipts': [], 'errors': []}


class BackendModel:
    def __init__(self):
        self.round = 0
    def bind_tools(self, tools):
        self.names = {t.name for t in tools}
        return self
    async def ainvoke(self, messages):
        if self.names == {'assess_request'}:
            name, args = 'assess_request', {'related': True}
        elif self.round == 0:
            name, args = 'present_page', {
                'page_id': 'fixture-page', 'title': '完整闭环测试页面', 'narration': '页面可以操作。',
                'body': '<h1>任务成果已就绪</h1><p id="value">0</p><button onclick="document.getElementById(\'value\').textContent=\'1\';parent.postMessage({type:\'interax.interaction\',data:{action:\'next\'}},\'*\')">下一步</button>',
            }
            self.round += 1
        else:
            name, args = 'finish_response', {}
        return AIMessage(content='', tool_calls=[{'id': 'fixture-' + str(self.round) + '-' + name, 'name': name, 'args': args}])


async def provider(text, context='', history=None):
    from voicemem.reply import _TOOL_HANDLER
    original = {'messages': [{'role': 'system', 'content': 'Fixture persona'}, *(history or []),
                             {'role': 'user', 'content': context + '\n\n' + text if context else text}]}
    async def events(request):
        observed['model_requests'].append(request)
        external = next((m for m in request['messages'] if m.get('name') == 'external_task_event'), None)
        if external:
            data = json.loads(external['content'])
            answer = '温和|任务状态是' + data['status'] + '，成果已在任务卡片中。'
        elif text == '普通聊天':
            answer = '温和|这是普通聊天。'
        else:
            tools = [m for m in request['messages'] if m['role'] == 'tool']
            if len(tools) < 2:
                method = 'createSession' if not tools else 'submit'
                parameters = {} if not tools else {'text': text, 'effort': 'high', 'schedule': {'mode': 'online', 'poll_interval': .25}}
                yield 'tool_calls', [{'index': 0, 'id': 'fixture-call-' + str(len(tools)), 'function': {'name': 'sdk', 'arguments': json.dumps({'method': method, 'parameters': parameters})}}]
                yield 'finish', 'tool_calls'
                return
            answer = '温和|任务已提交。'
        yield 'content', answer
        yield 'finish', 'stop'
    handler = _TOOL_HANDLER.get()
    if handler:
        async for chunk in handler(original, events):
            yield chunk
    else:
        yield '温和|普通聊天。'


@asynccontextmanager
async def lifespan(app):
    with tempfile.TemporaryDirectory(prefix='oil-loop-fixture-') as directory:
        backend = create_app(BackendSettings(data_dir=Path(directory) / 'backend'), BackendModel)
        app.mount('/interax', backend)
        # The server port is deliberately fixture-only and can be set independently.
        import os
        base = os.environ.get('STUDIO_FIXTURE_URL', 'http://127.0.0.1:8792/')
        settings = Settings(base + 'interax/', UPSTREAM, Path(directory) / 'scheduler.sqlite')
        fixture = ShortReplyTextTests()
        fixture.setUp()
        agent = fixture.agent
        agent.MIC_RATE = 24000
        agent.BC_ECHO_WINDOW_S = 2
        agent._SESSION_CONTEXT = SessionBuffer()
        agent._push_history = lambda chat, space, user, assistant, **kw: agent._SESSION_CONTEXT.add(chat, space, user, assistant, **kw)
        agent.vm.reply_stream = provider
        agent.task_scheduler = Scheduler(settings)
        app.state.agent, app.state.settings = agent, settings
        async with backend.router.lifespan_context(backend):
            app.state.backend = backend.state.service
            await agent.task_scheduler.start()
            try:
                yield
            finally:
                await agent.task_scheduler.close()


app = FastAPI(lifespan=lifespan)


@app.get('/')
async def index():
    return RedirectResponse('/ui/')


@app.get('/__test__/state')
async def state():
    return {**observed, 'sessions': app.state.backend.store.sessions(),
            'bindings': await app.state.agent.task_scheduler.journal.rows('SELECT sid,cursor,error FROM bindings'),
            'inbox': await app.state.agent.task_scheduler.journal.rows('SELECT sid,state FROM inbox')}


@app.get('/api/memories')
async def memories():
    return {'left': [], 'right': []}


@app.get('/api/spaces')
async def spaces():
    return {'spaces': [], 'active': 'fixture'}


@app.get('/interax-pages.js')
async def pages():
    return FileResponse(ROOT / 'studio/web/interax-pages.js', media_type='application/javascript')


@app.get('/pcm-player-worklet.js')
async def player():
    return FileResponse(ROOT / 'studio/web/pcm-player-worklet.js', media_type='application/javascript')


@app.websocket('/ws')
async def socket(ws: WebSocket):
    await ws.accept()
    with patch('studio.core.utils.interax.initialize.configuration', return_value=app.state.settings):
        conversation = Conversation(app.state.agent, ws)
    await ws.send_json({'type': 'session_ready', 'mode': 'llm_tts'})
    try:
        await conversation.attach_tasks()
        while True:
            message = await ws.receive_json()
            if message['type'] == 'user_text':
                pending = Pending(message['text'], '', None, spoken=False, transcript_managed=True)
                await conversation.publish_user_input(pending)
                await conversation.stop_reply(force=True)
                ready = asyncio.get_running_loop().create_future()
                ready.set_result(None)
                await conversation.start_reply(pending, ready)
            elif message['type'] == 'playback_checkpoint':
                await conversation.playback_checkpoint(message)
            elif message['type'] == 'interax_page_action':
                observed['browser_receipts'].append(message)
                await conversation.interax_page_action(message)
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        observed['errors'].append(type(exc).__name__)
        raise
    finally:
        await conversation.close_session()


app.mount('/ui', StaticFiles(directory=ROOT / 'studio/apps/ui', html=True))
app.mount('/interax-sdk', StaticFiles(directory=UPSTREAM / 'src/interax_sdk'))
