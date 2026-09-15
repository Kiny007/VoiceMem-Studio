"""Conversation-owned, asynchronous IPC to the official SDK in a Node process."""
import asyncio
import json
import os
from pathlib import Path
import shutil

from studio.harness.interax.policy import METHODS


class BridgeError(RuntimeError):
    """A structured integration failure; submission success may be unknown."""

    def __init__(self, detail):
        self.detail = detail
        super().__init__(str(detail.get("code", "bridge_failed")))


class Interax:
    """Own SDK handles for one WebSocket conversation and one Memory Space."""

    def __init__(self, settings):
        self.settings = settings
        self.process = None
        self.lock = asyncio.Lock()
        self.pending = None
        self.sequence = 0
        self.closed = False
        self.failed = False
        self.last_operation = None

    async def _start(self):
        if self.process is not None:
            return
        # The bridge needs no model-provider credentials or Node preload hooks.
        env = {key: value for key, value in os.environ.items()
               if key.upper() in {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL"}}
        self.process = await asyncio.create_subprocess_exec(
            shutil.which("node") or "node", str(Path(__file__).with_name("bridge.mjs")),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, env=env, limit=8 * 1024 * 1024)
        await self._exchange({"op": "initialize", "parameters": {
            "root": str(self.settings.root), "baseUrl": self.settings.base_url,
            "allowedMethods": list(METHODS),
        }})

    async def _exchange(self, message):
        self.sequence += 1
        message = {**message, "id": self.sequence}
        try:
            async with asyncio.timeout(60):
                self.process.stdin.write((json.dumps(message, ensure_ascii=False) + "\n").encode())
                await self.process.stdin.drain()
                line = await self.process.stdout.readline()
                if not line:
                    raise ValueError("bridge exited")
                response = json.loads(line)
                if response.get("id") != message["id"]:
                    raise ValueError("out-of-order IPC response")
                if message["op"] == "execute":
                    self.last_operation = {"method": message["method"], "response": response}
                if not response.get("ok"):
                    raise BridgeError(response["error"])
                return response["value"]
        except BridgeError:
            raise
        except Exception as exc:
            self.failed = True
            await self._stop_process()
            raise BridgeError({"code": "bridge_unavailable", "outcomeUnknown": message["op"] == "execute"}) from exc

    async def _operation(self, message):
        await self._start()
        return await self._exchange(message)

    async def call(self, message):
        """Serialize IPC; cancelled callers leave an owned response-draining task."""
        async with self.lock:
            if self.closed or self.failed:
                raise BridgeError({"code": "bridge_closed", "outcomeUnknown": True})
            if self.pending is not None:
                try:
                    await asyncio.shield(self.pending)
                except BridgeError:
                    pass
                self.pending = None
            if self.failed:
                raise BridgeError({"code": "bridge_unavailable", "outcomeUnknown": True})
            task = asyncio.create_task(self._operation(message))
            self.pending = task
            # Retrieve errors even if disconnect occurs before another call.
            task.add_done_callback(lambda done: None if done.cancelled() else done.exception())
            try:
                return await asyncio.shield(task)
            finally:
                if task.done():
                    self.pending = None

    async def describe(self):
        value = await self.call({"op": "describe"})
        return {**value, "lastOperation": self.last_operation}

    async def execute(self, method, parameters):
        return await self.call({"op": "execute", "method": method, "parameters": parameters})

    async def _stop_process(self):
        process = self.process
        if process is None:
            return
        if process.returncode is None:
            try:
                process.terminate()
            except ProcessLookupError:
                pass
        try:
            await asyncio.wait_for(process.wait(), 3)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()

    async def aclose(self):
        """Release local handles/tasks; backend cancellation is an explicit SDK action."""
        self.closed = True
        if self.pending is not None:
            self.pending.cancel()
            await asyncio.gather(self.pending, return_exceptions=True)
            self.pending = None
        process = self.process
        if process is not None and process.returncode is None:
            try:
                process.stdin.close()
                await asyncio.wait_for(process.wait(), 1)
            except (asyncio.TimeoutError, BrokenPipeError, ConnectionResetError):
                pass
        await self._stop_process()
