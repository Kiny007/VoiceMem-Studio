# Interax integration

Studio uses Interax's existing JavaScript SDK and Demo method wrappers in a
managed Node process. The SDK owns HTTP requests, command IDs, retries,
pagination, request/result handles and backend state. The Python/Node messages
are private local IPC; they do not define another Interax backend protocol.

## Linux configuration

Use the existing Studio Python 3.12 environment and a separately running Interax
backend. Provide Node.js **22.12 or newer** on the Studio process's PATH. The SDK
itself declares Node >=20; the bridge also imports the Demo `.js` ESM wrappers,
which require automatic ESM syntax detection in the selected Node version.
No npm install is required for the SDK or bridge.

```dotenv
STUDIO_INTERAX_BASE_URL=http://127.0.0.1:8100/
# Optional when Interax and VoiceMem-Studio are sibling checkouts:
# STUDIO_INTERAX_ROOT=/path/to/Interax
```

An empty `STUDIO_INTERAX_BASE_URL` disables integration. Relative root overrides
resolve against the process working directory; prefer an absolute override.
The root must contain both `src/interax_sdk/` and `demo/web/{catalog,controller}.js`.
The SDK has not been published to npm. Keep the upstream checkout and its module
graph intact; Studio does not copy or maintain a second SDK.

The URL maps directly to `InteraxClient({baseUrl})`; proxy path prefixes are
preserved. `INTERAX_BASE_URL` and `INTERAX_API_KEY` configure Interax's own model
provider. Studio continues using its selected reply provider's existing
credentials. No Interax client API key is invented: the current backend has no
built-in application-key authentication. Interax documents custom `fetch` or a
gateway for application authentication; this integration uses standard SDK
fetch against an endpoint reachable by the Studio server. A gateway requiring
additional application headers needs its deployment-specific fetch adapter.

Run Studio with its existing entry point, for example:

```bash
python -m studio --mode llm_tts --llm deepseek
```

`qwen` and `openai` also support this integration. Realtime and local MLX reply
adapters are rejected at startup when Interax is enabled. Startup checks inspect
Node, upstream source files, URL and mode without contacting either backend.

For containers, the **Studio container** needs Node and read access to the
upstream source tree, plus the two runtime configuration values. Existing
`docker/Dockerfile.cuda` and `compose.yaml` do not supply these optional resources;
prepare a deployment-specific image and mounts before enabling the feature.
The backend URL must be reachable from inside the container; container loopback
refers to that container, not the host. No Interax server is started by Studio.

## Routing and execution

`studio/harness/interax/policy.py` owns concise routing rules and a method
allowlist. `harness/interax/` is its compatibility export. Every foreground tool
turn reads `client.listSkills()` and the upstream catalog's `help`/`example`
fields. Changes to upstream Skill metadata therefore reach the model without
editing a duplicate Studio skill list. The local tool schema follows Interax's
Demo `sdk(method, parameters)` wrapper; individual SDK parameter schemas are
not reimplemented. Unknown selected Skills and unavailable methods are rejected.

```text
Confirmed user turn + existing memory/history/persona
  -> same reply provider + dynamic SDK/Skill catalog
  -> sdk(method, parameters)
  -> Studio ToolLoop -> local Node bridge
  -> InteraxClient / Session / Request / Question
  -> Interax API -> SessionService -> backend Agent and its Tools
  -> SDK results -> role=tool message -> same reply model
  -> existing tone parser, TTS, playback and heard-history pipeline
```

Interax's backend Tools are not registered directly in Studio. The model routes
page creation/revision, interactive apps, teaching visuals, research and charts
by the returned Skill descriptions, passing names in `submit.skills`. Ordinary
chat and personal-memory questions remain ordinary replies. Related changes
reuse the current Session; a new goal creates a new Session. Only sessions
created by the current bridge are accessible; global listing, arbitrary session
opening, deletion and display/playback receipts are not exposed to the model.

Submit publishes an accepted task card immediately after receiving its Request
handle, before waiting up to 15 seconds and obtaining request-scoped results and
a snapshot. Delivery notifications share the local IPC stream with tagged
command responses and are processed while waiting or draining a cancelled call.
The response preserves submission
identity when subsequent reads fail. `id=null` uses `session.poll()` directly.
`waiting`, `failed`, `rejected`, `cancelled`, `superseded` and `interrupted` retain
their actual meaning. A timeout is not completion; `request.progress/wait/results`
and `poll` support subsequent checks. While the WebSocket remains connected, a
Conversation-owned watcher polls all bridge-owned Interax Sessions in the active
space every two seconds and pushes task stages, waiting questions, result
failures and changed page catalogs, including results completed after the
foreground wait or after a new goal selects another Session. Read failures keep
previous results visible with a stale-state notice until a successful query.
It updates task cards without generating another spoken reply. Required questions must be answered;
`question.skip` preserves the backend's required-question check.

The loop accepts one complete tool call at a time, at most eight model rounds,
one creation attempt and one submission attempt per user turn, within a
100-second foreground budget. SDK network retries preserve the same command ID.
Application-level uncertain submissions are not automatically repeated. Tool
results are size-bounded with explicit truncation markers; focused SDK queries
can retrieve details. Tool call arguments and intermediate assistant messages
remain private; only the final answer is released to TTS. This buffers the final
model round until its tool/text decision is complete. Provider transports,
reasoning settings and connection cleanup remain in `voicemem/reply.py`.
Enabled DeepSeek/Qwen tool rounds retain first-event timeouts but do not add the
ordinary text path's connection retry; failures remain visible.

## Ownership, cancellation and output scope

One WebSocket Conversation owns a bridge per Memory Space. A foreground turn
captures both its space and VoiceMem instance. Ownership is checked around model
events and SDK operations so stale results cannot be spoken or drive subsequent
operations. SDK handles remain associated with the original space.

When integration is enabled, speculative early replies are disabled: a draft
ASR transcript cannot submit work, nor become a tool-free answer reused for a
confirmed tool request. Filler generation, unfinished-utterance follow-ups,
stranger replies, memory workers and warmups do not receive the tool handler.
The existing output/TTS/played-prefix contracts remain in use. This optional
mode trades speculative first-audio latency for confirmed tool execution.

Interrupting speech stops the foreground tool/model loop. A submitted SDK
operation may still finish: its response is drained by one owned IPC task before
another command is sent, preserving the real outcome and avoiding response
misassociation. Draining may delay the next command while the bounded SDK call
finishes. The next turn receives the last operation and current snapshot.
Disconnect closes local SDK/process resources and reaps tasks; it does not
delete data or cancel backend work. Users explicitly cancel backend execution
through the SDK `cancel` action. IPC failure closes the bridge for that
conversation/space; reopening the conversation is necessary to create a new
local bridge, and existing backend work may still exist.

### Interactive pages in the main Studio UI

After asking for an interactive page (for example, a binary-search visualization),
look for a task card once the submission is acknowledged. It shows generation,
waiting-for-answer, failure, cancellation or completion state. When the first
displayable result arrives, Studio automatically acquires and opens its page
panel embedded in the active conversation view while the spoken reply continues. A page may arrive after the spoken reply
if generation takes longer. Displayable results also add their title, summary
and a short task status entry in the conversation log. One initial result is
auto-presented for a connected chat; the page body stays in the dedicated
presentation area instead of becoming a page card. The home page `/` links to the supported
`/ui/technical.html` and `/ui/digital.html` interfaces. Both receive Interax
events through `studio-client.js`, reveal their conversation panel on task
updates, and use the shared page component for acquisition, rendering and
display confirmation. The older `/legacy` and `/classic` interfaces do not
provide this integration.

The display path uses the official SDK throughout:

```text
Request acknowledgement -> task card over Studio WebSocket
Session.poll() for each owned Session -> task states and page cards
  -> first displayable result -> embedded presentation area
  -> Result.prepare({mode: "display"})
  -> HTML documents over Studio WebSocket -> upstream createIframeRenderer
  -> sandbox load, fonts and paint ready -> Presentation.confirmDisplayed()
  -> page postMessage -> Studio WebSocket -> Session.submitInteraction(data)
  -> revised results -> updated page cards
```

Task cards bind Session and Request IDs to their original browser chat; creating
another chat does not redirect already tracked tasks. Earlier Sessions' page
buttons use the original Session for rendering and GUI submissions.
Polling lists pages without acquiring them, so discovering several pages does
not invalidate an active Presentation. Automatic or manual opening captures its
Session, item revision and a fresh selection token. Only that selection can
confirm display or submit GUI data; old socket callbacks and switched spaces
cannot confirm the new page. Actual rendering failure calls `reportFailure`.
Errors appear in the inline display area. Updated versions replace the relevant
cards and an active presentation for the same item is replaced by the latest
revision. Disconnect hides the area and releases its renderer listeners and
local watcher tasks.
Cards then show that updates have stopped and their page buttons are disabled.
The backend may continue working; connection-scoped bindings are not restored on
reconnect, so keep the conversation connected to receive late results.

Studio serves only Interax's `browser.js` and `src/viewport.js` renderer assets
from the configured checkout. The upstream renderer uses a sandbox iframe with
scripts/forms, checks postMessage source windows and preserves the artifact's
design viewport. HTML content goes directly to the browser, outside model
context and speech. Browser code sends no requests to the Interax backend and
receives no provider credentials. Existing configuration is sufficient.

VoiceMem speaks its model's answer through existing TTS; that is not an Interax
playback receipt. Interax's sequential Player is still outside this integration.

## Verification

Offline checks using existing dependencies only:

```bash
python -m unittest evals.test_interax_integration evals.test_deepseek_reply
node evals/test_interax_bridge.mjs
node evals/test_interax_pages.mjs
node --test studio/apps/evals/ui-client.test.cjs
node evals/test_transcript_ui.cjs
git diff --check
```

The Node regression imports the real upstream SDK and wrappers and supplies a
fake fetch implementation; it verifies outgoing commands, retry identity,
request-scoped results, questions, incomplete results, late HTML retrieval,
revision changes, display receipts, GUI submissions and forbidden playback receipts.
Python regressions use fake provider streams/HTTP and test tool-result roundtrips,
fragmented arguments, duplicate submission prevention, cancellation, ownership,
configuration, page watcher/action ownership and local IPC disposal. The page UI
regression uses a DOM/renderer fixture to verify readiness, errors and stale
selection handling; it is not a real browser rendering test. These checks never
start Interax or Studio. On Windows, run Python checks with `PYTHONUTF8=1` so
existing UTF-8 fixtures and test subprocesses use their intended encoding.

A local browser fixture serves both shipped interfaces and the real upstream
iframe renderer with deterministic WebSocket events, without model credentials:
`python -m uvicorn evals.serve_interax_ui_fixture:app --host 127.0.0.1 --port 8791`.
Open either UI, send a text request, wait for the page panel to open, and use its
Next button. The card remains available for a manual reopen.
The `/__test__/events` endpoint records acquisition, display confirmation and GUI
actions. Stop the fixture server after verification. This checks frontend wiring
and real sandbox rendering, not live model generation.

**Needs Linux runtime verification:** Python 3.12 with the deployment's Node and
read-only SDK checkout; model-provider tool calling with real credentials;
backend connectivity and proxy prefix; long-running generation and recovery;
two browser sessions/Memory Spaces; actual binary-search HTML rendering, controls,
display confirmation and revised page entry; real audio interruption and disconnect;
latency and any container-specific image/mount/network configuration.
