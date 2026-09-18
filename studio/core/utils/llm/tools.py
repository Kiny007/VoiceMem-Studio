"""Bounded SDK tool turns using the existing reply providers' streaming transports."""
import asyncio
from contextlib import aclosing
import json

from studio.core.utils.interax.component import BridgeError
from studio.harness.interax.policy import PROMPT


def compact(value):
    """Limit model context without mutating the SDK's authoritative result."""
    if isinstance(value, str):
        return value if len(value) <= 3000 else value[:3000] + " [truncated]"
    if isinstance(value, list):
        result = [compact(item) for item in value[:20]]
        if len(value) > 20:
            result.append({"truncated": True, "total": len(value)})
        return result
    if isinstance(value, dict):
        return {key: compact(item) for key, item in value.items()}
    return value


def encode_result(value):
    encoded = json.dumps(compact(value), ensure_ascii=False)
    if len(encoded) <= 48000:
        return encoded
    # Keep the response valid JSON and make the loss of detail explicit.
    return json.dumps({"truncated": True, "summary": encoded[:45000],
                       "next": "Use request.progress, getPage or result.refresh for focused details."}, ensure_ascii=False)


class ToolLoop:
    """Apply tools only to a confirmed foreground reply with captured ownership."""

    def __init__(self, bridge, current=lambda: True, operation_prefix=None):
        self.bridge = bridge
        self.current = current
        self.operation_prefix = operation_prefix

    def check_owner(self):
        if not self.current():
            raise asyncio.CancelledError("Interax reply ownership changed")

    async def __call__(self, original, events):
        async with asyncio.timeout(100):
            async with aclosing(self._run(original, events)) as output:
                async for text in output:
                    yield text

    async def _run(self, original, events):
        self.check_owner()
        request = {**original, "messages": [dict(message) for message in original["messages"]]}
        try:
            description = await self.bridge.describe()
        except (BridgeError, OSError):
            self.check_owner()
            request["messages"].append({"role": "system", "content":
                "本轮 Interax 连接不可用，无法确认后端状态。需要此能力时如实说明暂时无法查询或执行；不要声称已完成或重新提交。普通聊天继续正常回答。"})
            async with aclosing(events(request)) as stream:
                async for kind, value in stream:
                    self.check_owner()
                    if kind == "content":
                        yield value
            return
        self.check_owner()
        catalog = description["catalog"]
        names = [entry["key"] for entry in catalog]
        # Match Interax demo/frontend_model.py's sdk(method, parameters) contract.
        request["tools"] = [{"type": "function", "function": {
            "name": "sdk", "description": "调用 Interax 官方 SDK；方法与参数参考提供的操作目录，真实执行结果会返回。",
            "parameters": {"type": "object", "properties": {
                "method": {"type": "string", "enum": names},
                "parameters": {"type": "object", "additionalProperties": True},
            }, "required": ["method", "parameters"], "additionalProperties": False},
        }}]
        request["parallel_tool_calls"] = False
        request["tool_choice"] = "auto"
        request["messages"].append({"role": "system", "content": PROMPT})
        request["messages"].append({"role": "assistant", "name": "task_context", "content": encode_result(description)})
        submitted = False
        created = False
        for round_index in range(8):
            self.check_owner()
            if round_index == 7:
                request["tool_choice"] = "none"
            calls = {}
            content = []
            reasoning = []
            finish = None
            async with aclosing(events(request)) as stream:
                async for kind, value in stream:
                    self.check_owner()
                    if kind == "content":
                        content.append(value)
                    elif kind == "reasoning":
                        reasoning.append(value)
                    elif kind == "finish":
                        finish = value
                    elif kind == "tool_calls":
                        for delta in value:
                            index = delta.get("index", 0)
                            call = calls.setdefault(index, {"id": "", "type": "function", "function": {"name": "", "arguments": ""}})
                            if delta.get("id"):
                                call["id"] = delta["id"]
                            for key in ("name", "arguments"):
                                call["function"][key] += delta.get("function", {}).get(key) or ""
                            if len(call["function"]["arguments"]) > 64000 or len(calls) > 8:
                                raise RuntimeError("Reply model exceeded tool argument limits")
            self.check_owner()
            if not calls:
                if finish not in {"stop", "length"} or not content:
                    raise RuntimeError("Reply model returned no complete text response")
                # Tool rounds remain private; only the final answer reaches TTS.
                yield "".join(content)
                return
            if finish != "tool_calls" or any(not call["id"] for call in calls.values()):
                raise RuntimeError("Incomplete tool call; no SDK operation executed")
            assistant = {"role": "assistant", "content": "".join(content) or None,
                         "tool_calls": list(calls.values())}
            if reasoning:
                assistant["reasoning_content"] = "".join(reasoning)
            request["messages"].append(assistant)
            for call in calls.values():
                try:
                    if len(calls) != 1 or round_index == 7:
                        raise ValueError("Use one SDK call at a time; the tool budget is bounded")
                    if call["function"]["name"] != "sdk":
                        raise ValueError("Unknown tool")
                    args = json.loads(call["function"]["arguments"])
                    if not isinstance(args, dict) or set(args) != {"method", "parameters"}:
                        raise ValueError("Expected method and parameters")
                    method, parameters = args["method"], args["parameters"]
                    if method not in names or not isinstance(parameters, dict):
                        raise ValueError("Choose a catalog method with object parameters")
                    if method == "submit":
                        if submitted:
                            raise ValueError("A submission was already attempted this turn; query its state instead")
                        submitted = True
                    if method == "createSession":
                        if created:
                            raise ValueError("A session creation was already attempted this turn")
                        created = True
                    self.check_owner()
                    if self.operation_prefix is not None:
                        import hashlib
                        identity = hashlib.sha256(f'{self.operation_prefix}:{round_index}'.encode()).hexdigest()
                        result = await self.bridge.execute(method, parameters, operation_id=identity)
                    else:
                        result = await self.bridge.execute(method, parameters)
                except BridgeError as error:
                    result = {"error": error.detail}
                except (ValueError, TypeError) as error:
                    result = {"error": str(error)}
                self.check_owner()
                request["messages"].append({"role": "tool", "tool_call_id": call["id"],
                                            "content": encode_result(result)})
        raise RuntimeError("Reply model exhausted the SDK tool budget")
