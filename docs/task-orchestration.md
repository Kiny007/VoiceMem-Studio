# Task orchestration contract

This document defines the first version of the Studio to Interax task loop. The
Interax `SessionService` remains the authority for execution, status, generated
content and the durable event log. Studio owns the scheduler, the model inbox
and browser delivery policy.

## Objects and ownership

An Interax Session is a reusable execution identity. It may run related Requests
in sequence; a new Request waits for the previous execution to leave the active
state. Separate goals use separate Sessions. One Studio chat and Memory Space can
own several Sessions. The service limits owners, Sessions, poll workers and
model deliveries through `Settings` admission limits.

The backend event record has a Session ID, request ID, event ID, version and
monotonic sequence. `getUpdates({after, limit})` returns ordered pages and a
snapshot reference, without HTML bodies. Events are retained for the Session
lifetime in this version. A cursor conflict or an ahead cursor causes Studio to
restart from zero and rebuild its summary; it never creates a replacement
Session automatically.

## Scheduler and inbox

`poll_interval` controls how often the scheduler reads. `wake_at` or `delay`
controls a scheduled check. `delivery_policy` controls when the model sees
queued events: `ready` for usable online results, `completed` for terminal
results, or `at_wake` for a configured time. A required question is delivered
immediately. A terminal Session is polled at a reduced cadence after delivery.

The durable inbox records `queued`, `consuming`, `consumed` and `blocked`. A
fetch transaction stores events before advancing the cursor. A model failure
returns a batch to `queued` with bounded retries; after exhaustion it becomes
`blocked` and requires `retry_delivery`. The same batch identity is used for
model output and prevents duplicate tool effects. At-least-once delivery is the
guarantee; spoken output is committed before TTS and playback/heard status is
recorded separately.

## Lifecycle

The relevant states are `accepted`, `running`, `waiting`, `completed`, `failed`,
`cancelled`, `interrupted` and `superseded`. They describe backend execution.
Studio separately records fetched, queued, model-consuming, model-consumed,
display-acquired, displayed, playback-started and heard states.

`stop_waiting` pauses frontend delivery while backend execution continues.
`resume_waiting` enables delivery and triggers an immediate poll. `cancel`
requests backend cancellation and does not claim that a browser page or spoken
response has stopped until the corresponding event and playback reports arrive.
Stopping a current reply only interrupts its audio/model turn; it does not cancel
the backend Session. Browser page acquisition can fail for a stale revision;
the user must reopen the current Result before interacting.

## Recovery and races

Conversation objects are subscribers and can close at any time. The service-level
Scheduler owns timers, bridges and the SQLite journal, so a socket disconnect or
page refresh does not lose an inbox. On restart Studio restores owned Session IDs,
reads existing status and resumes from the stored cursor. It does not repeat an
unknown submission or tool side effect. Explicit retry uses a new operation
identity and the backend's existing idempotency rules.

If the user is speaking, a normal reply is generating, or TTS is playing, an
external task event stays queued. The scheduler also serializes model deliveries
per configured model pool. Timer and completion races are resolved by the same
durable inbox transaction and batch identity. Results from different chat/Space
bindings cannot be consumed by another subscriber.

## Context and presentation

Online notifications inject a bounded summary, current result references and
recent event metadata into the existing provider entry. Background tasks keep
their detailed history in Interax and the scheduler journal; only status,
summary, questions and references are injected. HTML remains in the presentation
channel. Summary versions record the covered cursor, and compression never
deletes raw events.

The browser receives task and Result cards through the Studio WebSocket. It calls
`prepare` to acquire a specific revision, renders the returned HTML in the
sandbox iframe, waits for actual readiness, then calls `confirmDisplayed`.
Failures, stale revisions, GUI interaction and disconnect warnings remain
explicit. `render` is a presentation operation and is not a progress poll or a
model wakeup.

## Current limits and verification

The first version is a single Studio process with SQLite and the existing Node
SDK bridge. It supports the remote `llm_tts` provider adapters already accepted
by Studio. The local MLX provider has no explicit KV-cache handle for this flow;
its existing `GpuLoop` prefix cache remains an optional performance optimization
and is never task state.

Covered deterministic paths include ordinary chat without a backend Session,
online and delayed background delivery, cursor pagination/reset, retries and
blocked inboxes, Session execution admission, multi-Session isolation, summary
budgets, conversation reconnect, page acquisition/render/confirmation and GUI
deduplication. Browser automation covered the actual technical entry and shared
page renderer; the digital-human entry shares the same client and contracts and
still needs a separate manual visual pass. Live paid providers, native MLX
generation, voice quality and multi-process deployment are outside this fixture.
