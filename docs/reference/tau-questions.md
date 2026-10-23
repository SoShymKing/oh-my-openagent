# Session question control

OMO prepares its pinned Senpi engine with `ctx.questions`. The facade belongs to
the live extension runner and resolves its session at call time. Captured methods
retain the runner's stale-context guard after replacement or reload.

`getPending()` returns detached JSON-serializable requests with `requestId`,
`questions`, `waitForAnswer`, `timeoutMs`, optional `required`, and the current
`deadlineAtMs`. Changing a snapshot does not change the builtin request.

`respond({ requestId, answers, comment, cancelled })` synchronously returns
`{ success: true, requestId, outcome }` or
`{ success: false, error }`. Refusals are `unknown_request`,
`question_incomplete`, and `invalid_response`. Each answer maps a question ID to
`{ selected: string[], text?: string }`; selections use option labels. Partial,
typed, multiselect, and comment-only answers are supported. An empty answer and
blank comment are incomplete. Cancellation takes precedence over answer fields.
Malformed answers and unknown labels never modify the request or its deadline.

The facade calls the builtin's shared accept/finish path. It does not send a
synthetic user message or settle only the underlying pending object. The builtin
removes the registry entry, emits its existing `ask-user:closed`, resolves the
blocking result, and aborts the original UI. Nonblocking model delivery remains
owned by the builtin, including queued outcomes during reload. Answer provenance
is the engine's existing `rpc_connection`.

Preparation lives in `packages/omo-native/bin/lib/question-control.js`, with a
small runtime template alongside it. All pinned source bindings and generated
files are validated before writes. Unsupported, partially prepared, or modified
prepared code fails with `question_control_incompatible`. Repeated preparation
is byte-stable. An engine upgrade needs a fresh source/lifecycle review and
compatibility fingerprints; silently carrying this patch across an unknown
engine is not supported.

The modular runtime imports the builtin registry statically. Installed Senpi also
ships a prelinked graph, so preparation covers its shared question-owner chunk
without importing a second registry or bypassing runtime snapshots. Terminal and
RPC worker bundles retain their own existing request owner. Direct binary builds
prepare the engine before staging and bundling; postinstall, engine swap, and
launch use the same helper. A same-version launch stamp does not skip facade
validation. Tau must use
its session/epoch routing, subscribe before querying snapshots, and treat the
snapshot as authoritative. Browser disconnect, navigation, and collapse do not
cancel a question. No browser timer owns the deadline.

## Paired Tau behavior

The original Windows terminal and Tau-created RPC workers both expose the
facade. Tau carries requests over its existing authenticated session connection;
it does not consume a second stream of worker stdout dialogs. A browser answer
closes the original terminal UI and completes the same blocking tool result or
nonblocking later-answer path as a terminal answer.

Tau snapshots contain `pendingQuestions`, `questionControl.supported`, and
`waitingForInput`. Answer commands capture the owning session, epoch and request.
An unsupported older runtime keeps ordinary chat available and advertises that
question forms are unavailable. Failed or disconnected submissions retain their
drafts; reconnect replaces pending state before an explicit retry. Drafts survive
navigation within the browser process, not a full browser restart.

## Build and local adoption

Build from the OMO checkout, using its manifest versions and pinned Rust
toolchain. The direct Windows build also requires the desktop engine artifact:

```powershell
bun install --frozen-lockfile
cargo build --release -p senpi-desktop-engine --target x86_64-pc-windows-msvc --locked
bun run build:omo-native
$omoVersion = (Get-Content package.json | ConvertFrom-Json).version
$nativeVersion = (Get-Content packages/omo-native/package.json | ConvertFrom-Json).version
bun run script/build-omo-binary.ts --target windows-x64 --omo-version $omoVersion --omo-ai-version $nativeVersion --out-dir .omo/release-binaries
```

Use the resulting binary with the matching Tau extension checkout for local
testing. Existing terminal processes and workers keep the engine they loaded:
restart them under the new binary to adopt runtime changes, then reload the Tau
browser for the new module and app-shell cache. Changing only Tau assets requires
a browser reload once the paired runtime is already available. Building does not
replace an installed executable or change a global npm link.

Focused engine preparation regressions live in
`packages/omo-native/test/question-control*.test.mjs`. The package gate uses
`bun test --timeout 20000 packages/omo-native/test`. Real-surface QA must use an
isolated agent/session directory and local model, record both terminal and worker
outcomes plus browser interactions, and verify task-process cleanup.
