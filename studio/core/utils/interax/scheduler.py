"""Service-owned pull scheduling and durable, at-least-once model delivery."""
import asyncio
from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import threading
import time
import uuid

from .component import Interax


TERMINAL = {"completed", "failed", "cancelled", "rejected", "interrupted", "superseded"}
IMPORTANT = {"interaction.ready", "interaction.question", "request.rejected", "request.failed",
             "execution.completed", "execution.failed", "execution.cancelled", "execution.interrupted"}


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


@dataclass(frozen=True)
class Schedule:
    mode: str = "online"
    poll_interval: float = 2
    wake_at: float | None = None
    delivery_policy: str = "ready"

    @classmethod
    def parse(cls, value, now):
        value = dict(value or {})
        if set(value) - {"mode", "poll_interval", "wake_at", "delay", "delivery_policy"}:
            raise ValueError("Unknown schedule field")
        mode = value.get("mode", "online")
        if mode not in {"online", "background"}:
            raise ValueError("Task mode must be online or background")
        interval = float(value.get("poll_interval", 2 if mode == "online" else 30))
        if not math.isfinite(interval) or not 0.25 <= interval <= 3600:
            raise ValueError("poll_interval must be 0.25..3600 seconds")
        if "wake_at" in value and "delay" in value:
            raise ValueError("Choose wake_at or delay")
        wake = value.get("wake_at")
        if "delay" in value:
            delay = float(value["delay"])
            if not math.isfinite(delay) or not 0 <= delay <= 2592000:
                raise ValueError("delay must be 0..2592000 seconds")
            wake = now + delay
        if wake is not None:
            wake = float(wake)
            if not math.isfinite(wake) or not now <= wake <= now + 2592000:
                raise ValueError("wake_at must be a UTC epoch within 30 days")
        policy = value.get("delivery_policy", "ready" if mode == "online" else "completed")
        if policy not in {"ready", "completed", "at_wake"} or (policy == "at_wake" and wake is None):
            raise ValueError("delivery_policy is ready/completed/at_wake; at_wake requires a time")
        return cls(mode, interval, wake, policy)


class Journal:
    """SQLite transactions run off the audio loop; raw records outlive summaries."""

    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS bindings (
              sid TEXT PRIMARY KEY, chat TEXT NOT NULL, space TEXT NOT NULL, config TEXT NOT NULL,
              cursor INTEGER NOT NULL DEFAULT 0, next_poll REAL NOT NULL DEFAULT 0,
              snapshot TEXT NOT NULL DEFAULT '{}', summary_version INTEGER NOT NULL DEFAULT 0,
              wake_sent INTEGER NOT NULL DEFAULT 0, stopped INTEGER NOT NULL DEFAULT 0,
              error TEXT NOT NULL DEFAULT '', generation INTEGER NOT NULL DEFAULT 0);
            CREATE INDEX IF NOT EXISTS binding_owner ON bindings(chat,space);
            CREATE TABLE IF NOT EXISTS inbox (
              sid TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL,
              state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, retry_at REAL NOT NULL DEFAULT 0,
              batch TEXT, PRIMARY KEY(sid,id));
            CREATE TABLE IF NOT EXISTS outputs (
              id TEXT PRIMARY KEY, chat TEXT NOT NULL, space TEXT NOT NULL, sid TEXT NOT NULL,
              text TEXT NOT NULL, delivery TEXT NOT NULL DEFAULT 'ready', heard TEXT NOT NULL DEFAULT '');
            CREATE TABLE IF NOT EXISTS operations (
              id TEXT PRIMARY KEY, method TEXT NOT NULL, parameters TEXT NOT NULL, result TEXT);
            CREATE TABLE IF NOT EXISTS chat_history (
              chat TEXT NOT NULL, space TEXT NOT NULL, payload TEXT NOT NULL,
              PRIMARY KEY(chat,space));
        """)
        if 'generation' not in {r['name'] for r in self.db.execute('PRAGMA table_info(bindings)')}:
            self.db.execute('ALTER TABLE bindings ADD COLUMN generation INTEGER NOT NULL DEFAULT 0')
        self.db.execute("UPDATE inbox SET state='queued' WHERE state='consuming'")
        self.db.commit()

    async def run(self, fn):
        def work():
            with self.lock, self.db:
                return fn(self.db)
        return await asyncio.to_thread(work)

    async def rows(self, sql, parameters=()):
        return await self.run(lambda db: [dict(r) for r in db.execute(sql, parameters)])

    async def execute(self, sql, parameters=()):
        await self.run(lambda db: db.execute(sql, parameters).rowcount)

    async def close(self):
        await asyncio.to_thread(self.db.close)


def context_data(row):
    """A bounded structured summary plus references; no HTML or instruction promotion."""
    snapshot = json.loads(row["snapshot"])
    return {
        "session_id": row["sid"], "mode": json.loads(row["config"])["mode"],
        "summary_version": row["summary_version"], "covered_cursor": row["cursor"],
        "status": snapshot.get("execution", "unknown"),
        "goal": str(snapshot.get("goal") or "")[:1000],
        "requests": [{"id": r.get("id"), "stage": r.get("stage")} for r in snapshot.get("requests", [])[-8:]],
        "questions": snapshot.get("questions", [])[:8],
        "results": [{k: item.get(k) for k in ("id", "requestId", "revision", "title", "summary", "display")}
                    for item in snapshot.get("items", []) if item.get("validity") == "current"][-12:],
    }


class Scheduler:
    """One process owner for timers, bridges and inboxes; sockets are replaceable subscribers."""

    def __init__(self, settings, *, clock=time.time, bridge_factory=Interax):
        self.settings, self.clock, self.bridge_factory = settings, clock, bridge_factory
        self.journal = None
        self.bridges, self.subscribers, self.consumers = {}, {}, {}
        self.pollers = {}
        self.poll_slots = asyncio.Semaphore(settings.max_polls)
        self.model_slots = asyncio.Semaphore(settings.max_models)
        self.task = None
        self.closed = False
        self.lock = asyncio.Lock()

    async def start(self):
        async with self.lock:
            if self.journal is None:
                self.journal = await asyncio.to_thread(Journal, self.settings.state_path)
            if self.task is None:
                self.task = asyncio.create_task(self._run())
        return self

    async def _run(self):
        while True:
            try:
                await self.tick(wait_polls=False)
            except asyncio.CancelledError:
                raise
            except Exception:
                # A failed durable write must not acknowledge or discard any event.
                import logging
                logging.getLogger(__name__).exception("Task scheduler tick failed")
            await asyncio.sleep(0.25)

    async def bridge(self, chat, space):
        key = (chat, space)
        async with self.lock:
            bridge = self.bridges.get(key)
            if bridge is None or bridge.failed or bridge.closed:
                if bridge is not None:
                    await bridge.aclose()
                if len(self.bridges) >= self.settings.max_owners and key not in self.bridges:
                    raise ValueError("Scheduler owner capacity reached")
                bridge = self.bridge_factory(self.settings)
                self.bridges[key] = bridge
                bindings = await self.journal.rows("SELECT sid FROM bindings WHERE chat=? AND space=?", key)
                await bridge.call({"op": "restore", "sessions": [r["sid"] for r in bindings]})
            return bridge

    async def attach(self, chat, space, subscriber):
        await self.start()
        previous = self.subscribers.get((chat, space))
        if previous is not None and previous is not subscriber:
            await previous.close_session()
        self.subscribers[(chat, space)] = subscriber
        await self.journal.execute('UPDATE bindings SET next_poll=0 WHERE chat=? AND space=?', (chat, space))
        await self.publish(chat, space)
        return BoundBridge(self, chat, space)

    def detach(self, chat, space, subscriber):
        if self.subscribers.get((chat, space)) is subscriber:
            self.subscribers.pop((chat, space), None)

    async def publish(self, chat, space):
        subscriber = self.subscribers.get((chat, space))
        if subscriber is None:
            return
        rows = await self.journal.rows("SELECT * FROM bindings WHERE chat=? AND space=?", (chat, space))
        tasks, pages, errors = [], [], []
        for row in rows:
            state = json.loads(row["snapshot"])
            for request in state.get("requests", []):
                tasks.append({"sessionId": row["sid"], "requestId": request["id"],
                              "title": request.get("request", {}).get("query", "Interax 任务"),
                              "stage": request.get("stage", "unknown"),
                              "questions": [{"id": q["id"], **q.get("payload", {})} for q in state.get("questions", [])],
                              "waitingStopped": bool(row["stopped"])})
            pages.extend({"sessionId": row["sid"], "requestId": item.get("requestId"),
                          "itemId": item["id"], "revision": item["revision"],
                          "title": item.get("title"), "summary": item.get("summary"),
                          "canDisplay": True}
                         for item in state.get("items", []) if item.get("canDisplay") and item.get("validity") == "current")
            if row["error"]:
                errors.append({"sessionId": row["sid"], "code": row["error"]})
        outputs = await self.journal.rows("SELECT id,text,delivery,heard,sid FROM outputs WHERE chat=? AND space=? ORDER BY rowid DESC LIMIT 32", (chat, space))
        try:
            await subscriber.publish({"tasks": tasks, "pages": pages, "errors": errors, "outputs": outputs})
        except asyncio.CancelledError:
            raise
        except Exception:
            self.detach(chat, space, subscriber)

    async def tick(self, *, wait_polls=True):
        rows = await self.journal.rows("SELECT * FROM bindings WHERE next_poll<=? ORDER BY next_poll LIMIT ?", (self.clock(), self.settings.max_polls))
        self.pollers = {sid: task for sid, task in self.pollers.items() if not task.done()}
        for row in rows:
            if row['sid'] not in self.pollers and len(self.pollers) < self.settings.max_polls:
                self.pollers[row['sid']] = asyncio.create_task(self.poll(row))
        if wait_polls:
            await asyncio.gather(*self.pollers.values())
        for key, subscriber in list(self.subscribers.items()):
            task = self.consumers.get(key)
            if (task is None or task.done()) and subscriber.ready():
                self.consumers[key] = asyncio.create_task(self.consume(key, subscriber))

    async def poll(self, row):
        async with self.poll_slots:
            config = Schedule(**json.loads(row["config"]))
            now = self.clock()
            try:
                bridge = await self.bridge(row["chat"], row["space"])
                batch = await bridge.call({"op": "updates", "sessionId": row["sid"], "after": row["cursor"], "limit": 100})
                snapshot = batch["snapshot"]
                def persist(db):
                    current = db.execute("SELECT * FROM bindings WHERE sid=?", (row["sid"],)).fetchone()
                    if current['generation'] != row['generation']:
                        return
                    if batch.get("reset"):
                        db.execute("UPDATE bindings SET cursor=0 WHERE sid=?", (row["sid"],))
                    cursor = batch["next_cursor"]
                    if not batch.get("reset") and cursor < current["cursor"]:
                        return
                    for event in batch["updates"]:
                        if event["session_id"] != row["sid"] or event.get("version", 1) != 1:
                            raise ValueError("Event scope or version mismatch")
                        db.execute("INSERT OR IGNORE INTO inbox(sid,id,seq,payload,state) VALUES (?,?,?,?,?)",
                                   (row["sid"], event["event_id"], event["seq"], encode(event),
                                    "queued" if event["kind"] in IMPORTANT else "recorded"))
                    # The full snapshot can be newer than this event page. Only publish/model
                    # deliver it once all intervening event pages are durably fetched.
                    caught_up = not batch["has_more"] and cursor >= snapshot.get("cursor", cursor)
                    if caught_up:
                        db.execute("UPDATE bindings SET snapshot=?,summary_version=summary_version+1 WHERE sid=? AND snapshot<>?",
                                   (encode(snapshot), row["sid"], encode(snapshot)))
                    if caught_up and config.wake_at is not None and now >= config.wake_at and not current["wake_sent"]:
                        db.execute("INSERT OR IGNORE INTO inbox(sid,id,seq,payload,state) VALUES (?,?,?,?, 'queued')",
                                   (row["sid"], f"wake:{config.wake_at}", cursor, encode({"kind": "schedule.wake", "seq": cursor})))
                        db.execute("UPDATE bindings SET wake_sent=1 WHERE sid=?", (row["sid"],))
                    next_poll = now + config.poll_interval if caught_up else now
                    if caught_up and snapshot.get('execution') in TERMINAL:
                        next_poll = now + max(30, config.poll_interval)
                    if config.wake_at is not None and not current["wake_sent"] and now < config.wake_at:
                        next_poll = min(next_poll, config.wake_at)
                    db.execute("UPDATE bindings SET cursor=?,next_poll=?,error=CASE WHEN error='poll_failed' THEN '' ELSE error END WHERE sid=?", (cursor, next_poll, row["sid"]))
                await self.journal.run(persist)
            except asyncio.CancelledError:
                raise
            except Exception:
                await self.journal.execute("UPDATE bindings SET next_poll=?,error='poll_failed' WHERE sid=?", (now + max(2, config.poll_interval), row["sid"]))
            await self.publish(row["chat"], row["space"])

    async def consume(self, key, subscriber):
        async with self.model_slots:
            if self.subscribers.get(key) is not subscriber or not subscriber.ready():
                return
            now = self.clock()
            def claim(db):
                rows = db.execute("SELECT * FROM bindings WHERE chat=? AND space=? AND stopped=0 AND error=''", key).fetchall()
                for row in rows:
                    config = Schedule(**json.loads(row["config"]))
                    snapshot = json.loads(row["snapshot"])
                    if snapshot.get("cursor", -1) < row["cursor"]:
                        continue
                    events = db.execute("SELECT * FROM inbox WHERE sid=? AND state='queued' AND retry_at<=? ORDER BY seq", (row["sid"], now)).fetchall()
                    if not events:
                        continue
                    kinds = {json.loads(e["payload"])["kind"] for e in events}
                    if config.delivery_policy == "at_wake" and now < config.wake_at and snapshot.get("execution") != "waiting":
                        continue
                    if config.delivery_policy == "completed" and snapshot.get("execution") not in TERMINAL | {"waiting"} and "schedule.wake" not in kinds:
                        continue
                    identity = hashlib.sha256(encode([row["sid"], [e["id"] for e in events]]).encode()).hexdigest()
                    for event in events:
                        db.execute("UPDATE inbox SET state='consuming',batch=? WHERE sid=? AND id=?", (identity, row["sid"], event["id"]))
                    return dict(row), identity, [json.loads(e["payload"]) for e in events]
            claimed = await self.journal.run(claim)
            if claimed is None:
                return
            row, identity, events = claimed
            data = context_data(row)
            data["event_ids"] = [e.get("event_id", "wake") for e in events]
            data['recent_events'] = [{'kind': e['kind'], 'seq': e['seq'],
                                     'text': str(e.get('payload', {}).get('text', ''))[:400]}
                                    for e in events[-6:]]
            data["reason"] = "scheduled_check" if any(e["kind"] == "schedule.wake" for e in events) else "task_update"
            try:
                await subscriber.consume(identity, data, self)
                # Reply/TTS may swallow a barge-in cancellation after freezing its heard prefix.
                await self.retry(row["sid"], identity, cancelled=True)
            except asyncio.CancelledError:
                await self.retry(row["sid"], identity, cancelled=True)
                raise
            except Exception:
                await self.retry(row["sid"], identity)
            finally:
                await self.publish(*key)

    async def retry(self, sid, identity, *, cancelled=False):
        def update(db):
            db.execute("UPDATE inbox SET state=CASE WHEN attempts>=2 THEN 'blocked' ELSE 'queued' END, attempts=attempts+?,retry_at=? WHERE sid=? AND batch=? AND state='consuming'",
                       (0 if cancelled else 1, self.clock() + (1 if cancelled else 5), sid, identity))
            if db.execute("SELECT 1 FROM inbox WHERE sid=? AND state='blocked'", (sid,)).fetchone():
                db.execute("UPDATE bindings SET error='model_retry_exhausted' WHERE sid=?", (sid,))
        await self.journal.run(update)

    async def commit_model(self, identity, chat, space, sid, text):
        def commit(db):
            db.execute("INSERT OR IGNORE INTO outputs(id,chat,space,sid,text) VALUES (?,?,?,?,?)", (identity, chat, space, sid, text))
            db.execute("UPDATE inbox SET state='consumed' WHERE sid=? AND batch=?", (sid, identity))
        await self.journal.run(commit)

    async def save_history(self, chat, space, turns):
        from dataclasses import asdict
        await self.journal.execute("INSERT OR REPLACE INTO chat_history VALUES (?,?,?)",
                                   (chat, space, encode([asdict(t) for t in turns[-6:]])))

    async def control(self, chat, space, sid, action):
        rows = await self.journal.rows("SELECT sid FROM bindings WHERE sid=? AND chat=? AND space=?", (sid, chat, space))
        if not rows:
            raise ValueError("Task belongs to another conversation")
        if action not in {"stop_waiting", "resume_waiting", "retry_delivery", "cancel"}:
            raise ValueError("Unknown task control")
        if action == "cancel":
            bridge = await self.bridge(chat, space)
            await bridge.execute("cancel", {"sessionId": sid})
        await self.journal.execute("UPDATE bindings SET stopped=?,next_poll=0,error='',generation=generation+1 WHERE sid=?", (int(action == "stop_waiting"), sid))
        if action == "retry_delivery":
            await self.journal.execute("UPDATE inbox SET state='queued',attempts=0,retry_at=0 WHERE sid=? AND state='blocked'", (sid,))

    async def close(self):
        self.closed = True
        tasks = [t for t in [self.task, *self.consumers.values(), *self.pollers.values()] if t]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await asyncio.gather(*(b.aclose() for b in self.bridges.values()))
        self.subscribers.clear()
        if self.journal:
            await self.journal.close()


class BoundBridge:
    """Scope tool operations to a durable frontend chat and Memory Space."""

    def __init__(self, service, chat, space):
        self.service, self.chat, self.space = service, chat, space

    async def describe(self):
        bridge = await self.service.bridge(self.chat, self.space)
        description = await bridge.describe()
        rows = await self.service.journal.rows("SELECT * FROM bindings WHERE chat=? AND space=?", (self.chat, self.space))
        description["task_context"] = [context_data(r) for r in rows][-8:]
        description["catalog"] = [entry for entry in description["catalog"] if entry["key"] not in {"poll", "request.wait", "request.progress"}]
        description["catalog"].extend([
            {"key": "schedule", "help": "Set a task schedule. sessionId required; mode online/background, poll_interval seconds, wake_at UTC epoch or delay seconds, delivery_policy ready/completed/at_wake.", "example": {"sessionId": "returned-id", "mode": "background", "delay": 60, "delivery_policy": "at_wake"}},
            *[{"key": name, "help": "Frontend waiting/delivery control; sessionId required. Does not cancel backend execution.", "example": {"sessionId": "returned-id"}} for name in ("stop_waiting", "resume_waiting", "retry_delivery")],
            {"key": "quick.time", "help": "Read the current UTC epoch without creating a task or storing tool details.", "example": {}},
        ])
        description["submit_schedule"] = "submit.parameters.schedule accepts mode, poll_interval, wake_at or delay, delivery_policy. All SDK operations can select an owned sessionId."
        return description

    async def execute(self, method, parameters, operation_id=None):
        service = self.service
        parameters = dict(parameters)
        if method == "quick.time":
            return {"utc_epoch": service.clock()}
        schedule = Schedule.parse(parameters.pop("schedule", None), service.clock()) if method == "submit" else None
        bridge = await service.bridge(self.chat, self.space)
        if method == "schedule":
            sid = parameters.pop("sessionId")
            config = Schedule.parse(parameters, service.clock())
            await service.control(self.chat, self.space, sid, "resume_waiting")
            await service.journal.execute("UPDATE bindings SET config=?,wake_sent=0 WHERE sid=?", (encode(config.__dict__), sid))
            return {"sessionId": sid, "schedule": config.__dict__}
        if method in {"stop_waiting", "resume_waiting", "retry_delivery"}:
            await service.control(self.chat, self.space, parameters["sessionId"], method)
            return {"ok": True}
        operation_id = operation_id or uuid.uuid4().hex
        if method == "createSession":
            sid = hashlib.sha256((self.chat + self.space + operation_id).encode()).hexdigest()[:32]
            rows = await service.journal.rows("SELECT sid FROM bindings WHERE chat=? AND space=?", (self.chat, self.space))
            if len(rows) >= service.settings.max_sessions and sid not in {r["sid"] for r in rows}:
                raise ValueError("Backend Session capacity reached for this chat")
            await service.journal.execute("INSERT OR IGNORE INTO bindings(sid,chat,space,config) VALUES (?,?,?,?)", (sid, self.chat, self.space, encode(Schedule().__dict__)))
            parameters.update(sessionId=sid, commandId=operation_id)
        if method == "submit":
            parameters["commandId"] = operation_id
            sid = parameters.get("sessionId") or (await bridge.describe()).get("sessionId")
            if not sid:
                raise ValueError("Create or select a Session first")
            await service.control(self.chat, self.space, sid, "resume_waiting")
            await service.journal.execute("UPDATE bindings SET config=?,wake_sent=0 WHERE sid=?", (encode(schedule.__dict__), sid))
        if method in {"createSession", "submit"}:
            def intent(db):
                old = db.execute("SELECT * FROM operations WHERE id=?", (operation_id,)).fetchone()
                if old and (old["method"] != method or old["parameters"] != encode(parameters)):
                    raise ValueError("Operation identity reused with different parameters")
                db.execute("INSERT OR IGNORE INTO operations(id,method,parameters) VALUES (?,?,?)", (operation_id, method, encode(parameters)))
                return json.loads(old["result"]) if old and old["result"] else None
            result = await service.journal.run(intent)
            if result is not None:
                return result
        result = await bridge.execute(method, parameters)
        if method in {"createSession", "submit"}:
            await service.journal.execute("UPDATE operations SET result=? WHERE id=?", (encode(result), operation_id))
        await service.journal.execute("UPDATE bindings SET next_poll=0 WHERE chat=? AND space=?", (self.chat, self.space))
        return result

    async def page_action(self, action, **parameters):
        action_id = parameters.pop('actionId', None)
        if action == 'interact' and action_id:
            identity = hashlib.sha256(encode([self.chat, self.space, action_id]).encode()).hexdigest()
            def reserve(db):
                row = db.execute('SELECT parameters,result FROM operations WHERE id=?', (identity,)).fetchone()
                if row:
                    if row['parameters'] != encode(parameters):
                        raise ValueError('GUI operation identity conflict')
                    if row['result'] is None:
                        raise ValueError('GUI submission outcome unknown; refresh the task before another action')
                    return json.loads(row['result'])
                db.execute('INSERT INTO operations(id,method,parameters) VALUES (?,?,?)', (identity, action, encode(parameters)))
            cached = await self.service.journal.run(reserve)
            if cached is not None:
                return cached
        bridge = await self.service.bridge(self.chat, self.space)
        result = await bridge.page_action(action, **parameters)
        if action == 'interact' and action_id:
            await self.service.journal.execute('UPDATE operations SET result=? WHERE id=?', (encode(result), identity))
        await self.service.journal.execute("UPDATE bindings SET next_poll=0,generation=generation+1 WHERE chat=? AND space=?", (self.chat, self.space))
        return result
