# Bounded MCP HTTP cancellation (work in progress)

An initialized HTTP client receives an ephemeral Mcp-Session-Id. Session IDs route cancellation; they do not grant project access or persist credentials. Legacy stateless POST remains supported but has no notification-cancellation ownership. Unknown supplied session IDs return 404, never silently fall back to stateless execution. HTTP GET still returns 405 (no SSE listener); DELETE removes that session and aborts its active cancellable execution.

Each session remembers all request IDs, preserving string/number identity and rejecting reuse as required by the MCP 2025-06-18 basic protocol. Limits: 32 sessions, 1024 request IDs/session, 256 UTF-8 bytes/string ID, 15 minutes idle expiry, existing 10 concurrent tool-execution slots. In-flight handlers are not idle. Cancellation/DELETE bypass execution-slot admission. Unknown, late, malformed and noncancellable notifications do not start work. The seen-ID set is never evicted within a session.

Canonical localapi_execute_api, localapi_execute_flow and localapi_run_plan are cancellable here. The two bounded apipost_execute_api/apipost_execute_flow aliases are also routed when the separate native adapter feature is present; this develop-based branch alone does not implement or grant those tools. CRUD changes are not treated as rollbackable transactions. A same-token policy update advances the execution epoch and aborts old active calls, while retaining session routing and consumed IDs; future calls read current policy. Rotation and disabling drop all sessions. The server close event also clears them, but does not claim that Node graceful close proactively cancels in-flight calls before waiting for HTTP shutdown. Requests that waited across an authorization change reject before dispatch.

Client notifications/cancelled cause the server to finish and persist cancelled execution evidence before ending the original POST with 202 and no late JSON-RPC reply. DELETE/policy cancellation still yields a terminal result or bounded authorization-changed error to callers still waiting. Activities and API history preserve cancelled status. Notification receipt or the SDK's immediate local abort rejection is not evidence that server-side work has finished.

Signals reach runPlan and its runtime. New variable commits stop at observed cancellation/read/retry boundaries; an already-entered store save, an earlier committed variable change, or a sent external request is not rolled back. Cancelled execution does not refresh debug-environment cache. Scope-save and final history persistence failures remain errors, not automatic network retries. The stdio extension below is a separately verified transport stage. Native adapter cancellation requires its own combined validation.

Local tests use the official SDK against the real HTTP app with two clients sharing request numbers, verify cancellation of only the intended plan, read its persisted terminal history, retain the other client's completed request, and confirm late notifications/ID reuse/session deletion behavior. Additional capacity/policy/TTL/typed-ID tests use the registry directly. Live-policy changes, in-flight DELETE, cancellation at ten occupied execution slots, API history, and injected history-save failure are additionally covered by the real SDK/HTTP fixture. Failed persistence remains visible in activity as recordSaved:false with a bounded error even when a cancelled client no longer waits for a reply. Exact new-head CI and combined Mongo driver cancellation remain WIP until separately verified.

References:
- https://modelcontextprotocol.io/specification/2025-06-18/basic
- https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation

## Stdio cancellation extension (WIP)

The stdio entrypoint now reuses the official MIT-licensed SDK 1.32.1 ReadBuffer/serializeMessage for bounded JSON-RPC framing. The existing exact SDK dependency is promoted from development to production, with an isolated production-only packaged stdio smoke and license check in desktop CI. It deliberately does not adopt SDK Server: our single shared dispatcher retains debug state and protocol concurrency limits, while request-local progress callbacks keep simultaneous activities separate. Existing protocol-version negotiation is unchanged.

The same typed-ID registry is process-scoped with idle expiry disabled. Limits are 1024 IDs/process, ten concurrent tool calls and 32 total pending handlers, 12 MiB input buffer, 8 MiB output frames, 12 MiB total output queue and five-second write-acknowledgment deadline. Cancellation notifications bypass handler admission. Oversized input or saturated/broken output closes the transport and cancels active execution instead of buffering indefinitely. Replies are framed atomically and may arrive in completion order.

EOF cancels active cancellable operations and waits for their handler/evidence cleanup. External SIGTERM/SIGKILL and the SDK client's two-second shutdown grace can still interrupt persistence; no guarantee of rollback or always-saved evidence is made. CRUD is not rolled back. Activities now accept cancelled and separately record failed persistence.

Local pure-stream tests cover zero/empty request IDs, cancellation during active input, EOF cleanup, input/pending/output bounds and EPIPE/close/timeout. Official SDK real-subprocess tests cover two simultaneous HTTP plans, cancellation of only one, separate disk activities, retained debug variables/new-project grants, plus raw EOF cancellation and clean exit. Exact new-head CI, production-only packaged smoke and additional full-slot/failure integration remain pending at this checkpoint.

### Lifecycle corrections and platform entrypoint

Activity finalization now precedes the sole reply; a failed activity write cannot produce both success and error for the same ID. Queued replies recheck accepted cancellation at the actual write boundary; already-started frames cannot be recalled. Input close without end, including already-destroyed input, aborts and settles. Activity metadata is bounded before writing; oversized progress step IDs are explicitly omitted rather than producing unreadable >4 KiB logs.

The first production smoke failed on macOS, while Ubuntu/Windows passed. A regression test reproduced the old argv-string entrypoint guard failing through a directory symlink and passed after realpath comparison. The smoke now captures bounded child stderr. The new exact CI must still verify this platform fix. The same first CI also hit the old baseline Faker quota/time-budget race; it did not contain PR3's existing ASCII optimization, and no budget/assertion is relaxed.

### Shared runtime prerequisite

This cancellation PR is now stacked on PR3 (fix/script-sequence-budgets), not duplicating its budget validation, diagnostics or ASCII optimization. The first stdio CI used the older develop runtime and hit its known Faker budget race. Keeping PR3 as the explicit base preserves feature-only diffs and the original six default-limit assertions; it does not change or enlarge safety budgets and is not a merge into develop/main.

ExecutionStatus remains explicit even when the output path later fails. An activity completed after execution/history persistence does not acknowledge client receipt; a frame already being written cannot be recalled. The recorded operation must never be replayed solely because the reply channel failed.

## Stdio early-error correlation

The same `requestKey` validation now governs stdio error correlation as session admission: safe integers and strings of at most 256 UTF-8 bytes may be echoed, including numeric zero and the empty string. Invalid IDs are omitted from error responses, never copied into the output and never replaced by `null` (the official SDK's error schema accepts an optional ID, not a nullable one). Legal duplicate IDs and tool/session quota failures still retain their original IDs. Invalid IDs consume no execution lease or session request quota.

Malformed JSON is classified as `-32700`; syntactically valid JSON rejected by the SDK JSON-RPC schema is `-32600`. Both use fixed short messages and omit the uncorrelatable ID. Later valid messages remain usable through the same official SDK stdio transport. This only fixes early error framing: frame/queue/input budgets, admission counts, cancellation, EOF handling, and mutation delivery/rollback semantics are unchanged.

## Scope-save cancellation admission

A script can finish successfully before its environment/global update waits in
Store's queue or for the project lock. The previous scope adapter checked abort
before calling `save`, but omitted the signal from that call. Cancellation during
that wait could therefore be followed by a new variable transaction. The existing
pure tests covered cancellation after `get` and before conflict retry, not this
queued-save boundary.

`persistScopeChanges` now forwards the exact execution signal to `Store.save`.
This feature line necessarily backports only the existing Store signal parameter
and entry/final-locked admission checks from PR4 (root commits `83cd69f` and
`11d128e`); it does not import active-source synchronization or integration ancestry.
The feature dependency remains `fix/script-sequence-budgets`.

The final check is **before entering asynchronous `writeProject`**, not an atomic
promise to abort until the physical journal file appears. An already admitted
transaction may finish after cancellation. There is no post-success abort check,
rollback claim, network replay, or new retry. Existing lock waiting is not made
promptly abortable. Reading may recover an older journal before the check; clean
fixtures assert that this cancelled candidate causes no new scope transaction,
not that all conceivable recovery leaves the disk unchanged. Terminal activity
and execution-history writes remain unsignalled and can still preserve evidence.

The bounded CI workflow uses a test-only real-file-lock gate around the original
Store.save, never a mocked save outcome. Owner cancellation and official SDK HTTP
and actual production stdio cancellation exercise pre/post scripts, completed
async child HTTP, both variable scopes, cancelled terminal readback, later-step
suppression, unchanged clean configuration files, prior pre-stage commits,
backup/restore, restart and an unrelated project. A separate actual Store case
cancels after confirmed persistence but before the caller continuation and retains
the committed value/acknowledgment. Pure fixtures pin exact signal identity,
queued rejection, confirmed late abort and unchanged storage-error identity.
The older feature line does not acquire root-only typed commit-outcome facilities;
genuine typed-uncertainty coverage remains an explicit root integration check.

Local verification is restricted to inspected pure helpers plus syntax/format;
no application, VM, XML or database workload was run locally. Actual owner/SDK/
Store workflow outcomes remain pending exact-head ordinary CI.

## Active plan edit/archive/result lifecycle acceptance

The existing workflow file now specifies one additional complete lifecycle for
ordinary CI, without production changes: an owner plan has already sent its first
HTTP request; owner edits its plan definition and archives the project; archive
alone leaves that dispatched run active; explicit owner cancellation then stops
before either version's later request. Confirmed `recordSaved` is checked against
the actual persisted run, its original snapshot/hash and manual source, while the
edited configuration and archived flag survive result append and application
restart. No fake save or forced outcome is used.

Official HTTP and production stdio SDK readers independently verify rejection
while archived and unaffected access to another project. Remembered HTTP grants
remain revoked through restart and owner unarchive. The fresh stdio reader is
explicitly given only the other project; it does not inherit HTTP grants. Reading
the same saved evidence requires an explicit HTTP regrant and a separately
started stdio reader granted the target. This does not claim owner archive removes
an existing stdio process's independent grant, or cancels already-dispatched work.
Restart, authorization changes and reads must not replay either plan version.

Only the success-path receipt already available on this feature is required;
root-only typed uncertainty and richer receipt fields are not backported. This is
closure of a cross-workflow acceptance gap, not a newly identified production
fix. Syntax/format are checked locally; the real lifecycle remains pending the
new exact-head ordinary CI. Existing tests and their limits remain unchanged.
