"""Serve the shipped UI with deterministic Interax events and no model services.

Run: python -m uvicorn evals.serve_interax_ui_fixture:app --host 127.0.0.1 --port 8791
"""
import asyncio
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles


ROOT = Path(__file__).resolve().parents[1]
SDK = ROOT.parent / "Interax" / "src" / "interax_sdk"
app = FastAPI()
events = []
HTML = """<!doctype html><html><head><meta charset="utf-8"><title>Search fixture</title>
<style>body{font:24px system-ui;padding:40px}button{font:inherit;padding:12px}</style>
</head><body><h1>二分查找测试页面</h1><p id="steps">比较次数：0</p>
<button onclick="document.querySelector('#steps').textContent='比较次数：1';
parent.postMessage({type:'interax.interaction',data:{action:'next'}},'*')">下一步</button>
</body></html>"""


@app.get("/")
def index():
    return RedirectResponse("/ui/")


@app.get("/interax-pages.js")
def pages():
    return FileResponse(ROOT / "studio/web/interax-pages.js", media_type="application/javascript")


@app.get("/pcm-player-worklet.js")
def player():
    return FileResponse(ROOT / "studio/web/pcm-player-worklet.js", media_type="application/javascript")


@app.get("/__test__/events")
def observed_events():
    return events


@app.websocket("/ws")
async def socket(ws: WebSocket):
    await ws.accept()
    task = {"sessionId": "fixture_session", "requestId": "fixture_request",
            "title": "二分查找交互页面", "stage": "running"}
    page = {"sessionId": task["sessionId"], "requestId": task["requestId"],
            "itemId": "fixture_item", "revision": 1, "title": task["title"], "summary": "点击下一步验证交互。"}
    await ws.send_json({"type": "session_ready", "mode": "llm_tts"})
    try:
        while True:
            message = await ws.receive_json()
            if message["type"] == "user_text":
                await ws.send_json({"type": "user_transcript", "text": message["text"], "input_turn_id": "fixture_input"})
                await ws.send_json({"type": "interax_state", "space": "fixture", "tasks": [task], "pages": [], "errors": []})
                await asyncio.sleep(0.2)
                await ws.send_json({"type": "interax_state", "space": "fixture",
                                    "tasks": [{**task, "stage": "completed"}], "pages": [page], "errors": []})
            elif message["type"] == "interax_page_action":
                events.append(message)
                response = {"type": "interax_page_result", "space": "fixture",
                            "token": message["token"], "action": message["action"], "ok": True}
                if message["action"] == "openPage":
                    response["result"] = {"documents": [{"mediaType": "text/html", "title": task["title"], "content": HTML}]}
                await ws.send_json(response)
    except WebSocketDisconnect:
        pass


app.mount("/interax-sdk", StaticFiles(directory=SDK), name="fixture-sdk")
app.mount("/ui", StaticFiles(directory=ROOT / "studio/apps/ui", html=True), name="fixture-ui")
