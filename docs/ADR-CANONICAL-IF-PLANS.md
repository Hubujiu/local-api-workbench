# Bounded canonical IF execution plans

## Status and evidence

This feature adds an independent canonical backend control, not a saved native
automation adapter. It depends on the fixed PR44 repeat-plan and PR88 discriminator
admission join. Neither dependency is implicitly merged by this feature.

The official IF help page describes a variable condition deciding whether child
APIs execute: https://wiki.apipost.cn/docs/test/if/ . Read-only inspection of the
legally downloaded Offline2 2.0.0 Linux archive corroborates ordered enabled child
execution only when the condition matches, and an error path for failed condition
evaluation. Archive SHA-256:
7c66b8963960dd22a384072ecb714c9d8ba1164bb2ecd8f2d90d325fa3d83942.
Plaintext send/index.js SHA-256:
5dabd6d0b85214084895a7044f9b045bb005cb010ecec156e98cf883a914ceff.
Relevant zero-based decoded-text offsets: comparator 33551953, variable helper
33552743, IF handler 33631365, true-only child guard 33632042. These identify
static evidence, not code copied into this repository. The original was not run.

Original comparison includes coercion, empty-value special cases and additional
operators. Its variable merge includes sources not represented by this canonical
plan. We do not claim those broader semantics. In particular, a saved nonempty
event_list → ordered children/request/settings assembly contract is still missing.
This does not make native automated_testings imports executable.

## Definition and supported domain

A group is { type: "if", id, name?, enabled?, condition, steps }. Its condition is
{ op, left, right }. Each operand is exactly { literal: value } or
{ scope: "globals" | "environment" | "runtime" | "iterationData", name }. No interpolation, expression,
function, regex, implicit variable source, alternate branch or fallback is added.

- eq/neq compare same-type primitives: null, boolean, finite number, nonempty
  well-formed text of at most 8192 UTF-8 bytes.
- gt/gte/lt/lte require two finite numbers.
- contains/notContains compare two bounded nonempty strings, in left-to-right order. Matching is case-sensitive, does not normalize Unicode, and treats regex-like characters literally. These are canonical Workbench rules and do not imply native comparator equivalence.
- iterationData is available only inside a canonical inline-data repeat and reads a top-level own field. All potential rows are checked before execution, including disabled or false branches.
- Mixed types, empty text, nonfinite numbers, objects, unknown operators/fields and
  missing variables are errors, not coerced values or false.
- IF descendants support HTTP, gRPC, Socket.IO, TCP, WebSocket and SSE leaves and IF/fixed-repeat groups.
  TCP, WebSocket and SSE use the existing canonical protocol wrapper, frozen
  definitions, bounded scripts, extraction and result evidence. gRPC uses its
  independent leaf, executor and temporary credentials; Socket.IO likewise uses
  its independent leaf and executor. Repeat-until descendants admit HTTP/TCP/WebSocket/SSE/gRPC/Socket.IO, while runtime-row descendants
  admit HTTP/TCP/WebSocket/SSE/gRPC/Socket.IO, including nested IF/fixed repeats and disabled definitions.
  Protocol execution and repeat admission remain unchanged. Scope-commit
  uncertainty in any active-IF plan follows the plan-wide safety upgrade below.
- All definitions, including disabled and false descendants, undergo complete
  static validation before any request. Enabled potential protocol leaves retain
  existing credential preflight; false is not a way to evade admission or grants.

The canonical comparisons need no new dependency or third-party source.
They are independently implemented using JavaScript primitive operations under
the repository MIT license.

## Ordering, scopes and effects

A condition is evaluated when execution reaches it, against the current committed
scope state, never during pre-expansion. Repeat evaluates an inner IF anew on each
iteration. A false decision skips the complete descendant subtree without request
preparation, scripts, native tasks, database queries, extraction or scope writes.
Disabled groups do not evaluate conditions or emit decisions.

Scope lookup is explicit and uses an own data property. There is no precedence
fallback. The legacy hidden-name list suppresses IF lookup in all three scopes,
including explicit globals/environment. This is intentionally stricter than
pm.globals.get/pm.environment.get, which can read their explicit maps. Deleting a
runtime name can therefore hide an older global, and a subsequent explicit
environment write alone does not remove that hidden marker.

Only plans containing IF preflight initial variable inputs as bounded hook-free
JSON data before createScopes can serialize them. Explicit scope fields must be
plain maps (absent/undefined retains the historical default); hidden must be a
dense variable-name array. Proxy, accessors, custom serialization hooks, cycles,
nonfinite numbers and custom prototypes are rejected without calling hooks.
Inputs share a conservative 4 MiB accounting bound, 100000 visited nodes and
depth 32. No scope grants or secrets are created.

A runtime condition error stops the whole plan, including outer siblings. Prior
completed network effects and accepted scope commits remain. No rollback or replay
is implied. Ordinary leaf failures retain existing continue-on-failure semantics.
Cancellation before a decision performs no lookup; cancellation during a request
retains existing request evidence and starts no later child or sibling.

## Bounds and evidence

IF and repeat share maximum group depth 4, at most 200 potential expanded request
leaves, 4 MiB logical expanded configuration, existing frozen-definition and data
limits, and 8 MiB soft evidence stop. Additionally, at most 200 potential IF
decisions are admitted. Disabled/false definitions still consume static budgets.
Condition literals are charged with their repeat multiplier.

The evidence ceiling includes leaf records plus condition decisions. It is checked
before the next occurrence, preserving the terminal record that crosses it; it is
not a new transport response cap. A cursor tracks actual control traversal instead
of treating result count as a flattened index. Evidence receipts identify a pending
condition by kind and occurrenceId; remaining request count is explicitly potential
when IF is present. Pure repeat identity and existing evidence shapes are retained.

conditionResults are separate from HTTP results. Each decision has stepId/groupId,
an injective repeat-aware occurrenceId, status, and either matched or a sanitized
PLAN_CONDITION_INVALID error. Operand values are not repeated into decision logs.
A false-only plan passes with no fabricated HTTP successes. Initial cancellation
has no decisions. Condition errors return failed with stopReason condition-error.

## Storage and consumers

Canonical snapshot/version/hash, owner run/history, full project backup/restore and
restart retain IF definitions and decisions. Changing a condition produces a new
frozen version without rewriting earlier runs. Restoring a project grants no
runtime database/protocol access and triggers no requests.

Canonical history and MCP plan lists expose small condition count/failure summaries
(maximum five failed decisions), not every decision. Full evidence remains in the
canonical execution-result reader. HTTP failedStepCount remains a leaf count;
failedConditionCount is separate.

MCP final progress marks potential total, actual completed leaves, finished status
and decision count. Final activity changes execution status without blaming the
last successful leaf or removing its repeat identity. Existing project allowlist,
read/write/execute grants and record persistence behavior remain required.

Native-compatible plan/result projections reject canonical IF. Result rejection
also checks conditionResults when a historical record has no snapshot; no silent
linear projection is allowed. Definition-only native export policies are otherwise
unchanged. No UI feature, saved-native bridge, else group or automatic replay is
included.

### CLI declaration-level grant preflight

For IF plans only, enabled potential declarative before/after database operations
or nativeTasks database entries require an explicit invocation grant before any
wire, even if a condition would be false. Without --database-stdin the existing
grant validator sees an empty map and rejects those required bindings. This is a
deliberately stricter new IF contract, not evidence of an earlier authorization
bypass: an unexecuted false branch previously performed no database call.

Disabled ancestors require no binding. Pure HTTP-only IF does not newly validate
an unrelated legacy DB catalogue. Existing non-IF linear/repeat behavior is
unchanged. This is static declaration recognition only; arbitrary script-driven
database calls retain their existing runtime authorization checks, not a claim of
complete static discovery. No connection is persisted or borrowed across runs.

### Terminal reporting failures

The terminal IF progress callback is awaited before persistence. Synchronous throws
and rejected promises do not discard completed HTTP or condition evidence: the
run is marked failed (cancelled stays cancelled), with a sanitized progressFailure
and retry_safe false. An existing condition-error/evidence-limit stop reason wins;
otherwise stopReason is progress-failure. No last successful leaf is relabelled.
Cancellation that arrives while the terminal callback settles takes precedence
whether that callback resolves or rejects; completed leaf and decision evidence
and any existing stop reason remain intact. The complete result, including this
notification failure, is then saved once by the
normal record path, so reopened history agrees with the returned receipt. This does
not retrofit unrelated older per-step reporter behavior on the fixed dependency
base; integration retains its existing per-step progress-failure contract.

### Accepted-root integration checks

The independent IF delta is transplanted onto backend integration
835251263cdd841715abdb75fcf3a045fbf96429 (tree
c73b411c7ebac044a5ab331391508793277eadc9), without replacing older feature copies
of the core, MCP dispatch or native projections. The integration keeps the root's
native-write authority preflight, progress fail-stop, collection switching and
commit logic, service resolver, database executor, and native HTTP shape checks.
IF decisions are evaluated before selecting a leaf's collection context.

`plan-if-root-boundaries.test.mjs` checks enabled native Redis SET behind a false
condition is refused before any earlier executor/preparation callback, disabled
ancestors do not acquire authority, leaf reporter failures stop later conditions,
explicit condition scopes do not borrow collection values, and IF/repeat frozen
backups preserve the three catalogues and unique tuple sample guards in both
schema dialects. Native linear projections and native full-plan exports still
refuse IF rather than silently flattening it; explicit definition-only exports
remain a separate supported subset. These are model/executor contracts, not real
Redis or wire acceptance.

The additional OAuth2 workbench entrypoint contract uses a fictional loopback
owner token exchange, explicitly saved frozen Bearer definition, skipped IF child
and repeated accepted child. It covers both official SDK transports, CLI, full
backup/restore/restart and an owner run of the fresh copy, with unchanged source
and unrelated project and no automatic token exchange or effect replay.

Local integration runtime checks remain blocked by a missing locked
`node-oauth1@1.3.0` in the available dependency cache. Owner, official SDK, CLI and
real-wire cases must pass on this exact combined tree in normal CI before this
integration is accepted. Passing the fixed-base feature tree or pure contracts is
not a substitute. No runtime test is skipped or weakened to accommodate that
local dependency failure.

### In-flight IF cancellation and project revocation

`plan-if-revocation-sdk.test.mjs` crosses the official HTTP SDK with an IF/repeat
plan, a completed loopback effect and accepted environment-variable commit, then
a second genuinely held HTTP child. It checks both an SDK cancellation signal and
owner project-grant reduction. Neither path may start the next child, repeat
iteration or following condition. Prior effects are retained, not rolled back.

Each action is paired with a normal run save and an actual missing required API
file introduced only after the second request is observed. The test observes the
real Store append input without replacing its save result or error. The missing
file causes a pre-journal fail-closed read/save refusal, not an unknown-commit
claim: activity reports recordSaved false while completed-response evidence is
only observed at the attempted append boundary, and no durable run is claimed.
Exact removed fixture bytes are restored only after the terminal boundary.

The SDK's rejected promise alone is not success evidence. The test also joins
network closure, server terminal activity and actual append completion, checks
run/decision identities or unchanged damaged bytes, restarts without replay, and
checks an unrelated retained project remains unchanged before a fresh authorized
call. Owner grant changes advance the global HTTP authorization epoch; this is
not a promise that another old in-flight session survives. Persisted remembered
revocation is checked after restart. These four SDK cases require exact combined
CI; the local dependency-load failure is retained rather than skipped.

## Canonical IF TCP extension

No native format is inferred and no original application is executed. Protocol
references are admitted provisionally, resolved at snapshot creation, and checked
again against the IF protocol capability set (TCP, WebSocket and SSE) before the
frozen plan is accepted. Saved snapshots
survive live edits/deletion, project backup/restore and restart.

Potential active TCP leaves inside IF require an executor before any earlier HTTP request
or script runs, even when their IF will be false. Existing credential validation
still precedes all network work. TCP does not gain header/TLS credentials; a later
active sibling transport with a required runtime credential still blocks the
entire run when that credential is missing. Disabled ancestors need no executor,
but their definitions and script envelopes are validated.

False IF produces decision evidence but no child script, socket or synthetic
success. TCP extraction remains atomic across runtime/environment/global scopes.
An uncertain TCP scope commit in a conditional plan stops before further work,
retains transport evidence and marks retry unsafe. Cancellation, the shared 8 MiB
evidence stop, failed record append and genuine journal uncertainty retain the
existing no-replay contract. Ordinary HTTP IF and fixed-repeat behavior remain
unchanged; native projections and staged load do not gain TCP support.

`plan-if-tcp-model.test.mjs` covers the control/transport admission matrix.
`plan-if-tcp-workflow.test.mjs` uses local HTTP/TCP peers, owner routes, official
MCP HTTP/stdio clients and the real CLI to verify execution and persistence. Its
oversized evidence check explicitly uses an injected executor, not a claim of
transport-limit acceptance.


## Canonical IF WebSocket extension

Canonical IF now accepts WebSocket leaves alongside HTTP and TCP. One capability
matrix intersects every enclosing control policy: fixed repeats retain their
existing transports, while repeat-until subtrees now admit HTTP/TCP/WebSocket/SSE/gRPC/Socket.IO and
runtime-row subtrees admit HTTP/TCP/WebSocket/gRPC/Socket.IO even beneath false or disabled IF nodes. No native automation format is inferred;
staged load and native projections retain their existing rejection boundaries.

Saved protocol references are provisional until snapshot resolution; frozen
snapshots are checked again against the IF capability set. All definitions,
including disabled nodes, retain static payload, script and structure validation.
Potential active leaves under a false IF still require the protocol executor and
any required per-run handshake credentials before an earlier HTTP request or
script may run. Credentials are neither persisted nor inherited by later runs.

WebSocket uses the existing bounded wire executor, extraction, cancellation and
scope-commit paths. A false IF opens no connection. Extraction can feed later
HTTP leaves, with existing atomic scope behavior. Uncertain scope commits retain
observed transport evidence and stop further work with retry unsafe; they must
not cause automatic replay. No new reconnect or retry behavior is introduced.

`plan-if-websocket-model.test.mjs` covers capability intersections, frozen
references and false/disabled graph validation. The companion workflow tests use
real loopback WebSocket and HTTP peers across owner, official MCP and CLI paths,
with persistence, cancellation and uncertainty checks. Synthetic executor tests
remain explicitly identified where used to exercise evidence size boundaries.

## Canonical IF SSE extension

The conditional capability matrix also admits SSE; execution still uses the
existing bounded captureSSE executor and dynamic conditional protocol set.
This is canonical support only, not a claim about original application automation
SSE formats. Repeat-until and runtime rows are admitted by the extensions below;
staged load and native projections keep their existing restrictions.

EOF completes a capture. maxEvents and duration produce partial results, with
extraction only when that status is explicitly expected. Cancellation retains the
executed step and its cancelled outcome, but the existing error path does not
return buffered events. No automatic reconnection or retry is added. False IF
opens no stream, while potential active SSE leaves still need executor authority
and required handshake credentials before preceding HTTP runs. Unknown scope
commits stop further work without replay.

The SSE model and loopback workflow tests cover these contracts, nested fixed
repeat occurrences, owner/CLI/official MCP HTTP and stdio execution, frozen
snapshot backup/restore/restart, and scope-commit uncertainty.


## Canonical IF gRPC extension

Canonical IF admits gRPC as a distinct leaf, not a wire protocol name. Nested
fixed repeats use the existing frozen gRPC definitions, temporary credential
bindings and executor. Potential enabled IF descendants require an executeGrpc
function and complete required credentials before any earlier HTTP request or
script, even when the condition will be false. Disabled groups still validate
definitions and grpcScripts recursively, but require no executor or credentials.

The existing unary, server-streaming, client-streaming and bidi implementations
retain their RPC deadline, bounded messages and cancellation behavior. No new
retry, reconnection, native mapping or streaming session format is introduced.
Response metadata and trailers remain excluded from saved plan evidence.

Scripts and extraction publish values through the existing scope commit path
before later conditions evaluate. An uncertain scope commit from an IF gRPC leaf
stops execution under continue as well as stop, preserves completed RPC evidence,
and never publishes an unconfirmed extraction or replays the RPC. Plain legacy
gRPC retains its prior behavior only when no active IF is present. Repeat-until
ancestor restrictions now admit HTTP/TCP/WebSocket and runtime-row restrictions
admit HTTP/TCP/WebSocket;
staged load and native projections stay restricted.

Targeted tests: plan-if-grpc-model.test.mjs and plan-if-grpc-workflow.test.mjs.

## Canonical IF Socket.IO extension

Canonical IF admits Socket.IO as a separate leaf and executor, not a WebSocket
wire alias. Existing v2/v4 connections, namespaces and bounded emit/wait/ack
commands retain their contracts. No Socket.IO scripts, reconnect or replay are
introduced. Active IF descendants require an executeSocketIO function and
required per-run credentials before preceding HTTP or scripts, including false
conditions. Disabled descendants still validate definitions but do not require
an executor or credentials.

Unknown scope commits, whether reported as ProjectCommitUncertain or its error
code, stop IF Socket.IO execution even under continue, preserving completed ACK
evidence without publishing unconfirmed extraction. Non-IF Socket.IO siblings in
an active-IF plan now also stop on unknown commits; plans without active IF retain
their historical continuation behavior. Repeat-until, runtime-row,
staged-load and native restrictions are unchanged; this does not claim an
original-application automation save format.

The IF-specific model and workflow tests cover capability intersections, real
v2/v4 websocket/polling/auto, private namespace, binary and multiple ACK arguments,
false and disabled conditions, independent executor and credential preflight,
unknown scopes, cancellation, scope and journal uncertainty, and no replay.
Owner, CLI and official MCP HTTP/stdio runs verify frozen definitions across
backup, restore and restart; per-run credentials do not enter saved project data.
Existing repeat tests are retained as regression coverage, not IF acceptance.

## Active IF scope-commit safety upgrade

This is an intentional safety-semantic change, including existing HTTP-only IF
plans and non-IF siblings. If the frozen graph contains an enabled IF reached
through enabled ancestors, any leaf with an unknown scope commit stops the
entire run, even under failurePolicy=continue. Both ProjectCommitUncertain
instances and PROJECT_COMMIT_UNCERTAIN error codes are recognized in this scope.
A false IF remains potentially active for this rule; disabled IF and disabled
ancestors do not independently opt in. The rule is conservative even when the
IF already completed or later work would not read the affected variable.

A commit can reach disk while its acknowledgement is lost. Restoring the old
in-memory scopes is not a storage rollback: continuing could evaluate a later
IF against stale values and repeat a business effect. The runner preserves the
completed response/script evidence, marks retrySafe=false, reports
stopReason=scope-commit-unknown, and does not start further occurrences,
conditions or requests. It neither retries the write nor replays the request.
Read/recover durable project state before deciding on any new execution.

This replaces the former mixed behavior: wire leaves were stopped according to
IF protocol types, gRPC/Socket.IO according to IF leaf IDs, and some HTTP or
unrelated siblings could continue. It can therefore stop older plans earlier.
No protocol execution authority, credential preflight, admission restriction,
occurrence identity, evidence limit or execution budget is broadened. Plans
without active IF retain their existing legacy behavior; repeat-until,
runtime-row and scripted-protocol mandatory stops remain authoritative.

The protocol-chain integration tests perform real Store writes and then throw
an uncertain acknowledgement, verifying that disk has the new value while the
run retains its old value and stops without replay. They cover true/false IF,
disabled ancestors, HTTP and all five protocol sibling types, fixed-repeat
occurrences, HTTP/TCP/WebSocket until, HTTP runtime rows, and scripted wire/gRPC phases. HTTP uses a
loopback peer; protocol executors in this cross-feature fixture are injected.
These checks do not simulate a journal crash or establish wire conformance.

### TCP repeat-until extension

At the TCP extension milestone, canonical `repeat.untilCondition` admitted HTTP
and TCP descendants, while WebSocket, SSE, gRPC, and Socket.IO descendants were
rejected even under false or disabled branches. Runtime rows were HTTP-only at
that milestone; their current boundary is HTTP/TCP/WebSocket. The WebSocket restriction is
superseded by the extension below. Unresolved protocol references
are provisional during authoring and are revalidated after snapshot resolution.

TCP uses the existing per-occurrence wire executor, framing, extraction, scripts,
and cleanup. Tail conditions run after the whole iteration, use committed scopes,
and retain the existing count exhaustion, decision/request/evidence budgets and
cancellation semantics. Executor authorization covers every potential enabled TCP
leaf before any earlier HTTP work. A possibly committed extraction stops before
another exchange or condition; the completed response is never replayed.

Owner, canonical MCP HTTP/stdio, and CLI share the frozen execution graph and
receipt format. No native import formats, new transport options, runtime-row
protocol support, or load-run protocol support were introduced by that milestone.

### WebSocket repeat-until extension

At the WebSocket milestone, canonical `repeat.untilCondition` admitted HTTP, TCP
and WebSocket descendants. SSE, gRPC and Socket.IO remained rejected, including false and disabled branches.
Every enclosing policy still intersects: runtime rows at that milestone admitted HTTP/TCP/WebSocket,
including a WebSocket leaf inside nested repeat-until. Staged load
and native projections keep their existing restrictions; this is canonical
Workbench execution, not native automation-format equivalence.

WebSocket uses the existing bounded per-occurrence wire executor, scripts,
extraction and cleanup. A new connection is opened for each occurrence; temporary
handshake credentials remain keyed by the frozen leaf ID and are not persisted.
The default expected status remains `completed`: timeout/limit captures remain
`partial` and do not extract unless the plan explicitly expects `partial`. No
close-code interpretation is changed. Tail conditions run after the complete iteration against
committed scopes. Count exhaustion, decision/request/evidence budgets,
cancellation and no-replay handling of uncertain scope commits remain unchanged.
Unresolved saved references remain provisional during authoring and are validated
again after resolution. Potential enabled WebSocket leaves, including those under
false IF conditions, require executor and handshake-credential preflight before
any earlier HTTP request or script runs. No reconnect, retry or new wire mode is
introduced.

The WebSocket repeat-until model and workflow suites cover admission boundaries
and canonical execution through owner, official MCP HTTP/stdio and CLI entrypoints,
using loopback peers for transport evidence. Synthetic executor checks are
identified separately and do not establish external interoperability.


### gRPC repeat-until extension

At the gRPC repeat-until milestone, canonical `repeat.untilCondition` additionally
admitted independent `grpc` leaves. SSE and Socket.IO remained excluded. Capabilities intersect at every
ancestor: at this repeat-until milestone runtime rows still excluded gRPC, even beneath false IF conditions,
disabled nodes, nested until or fixed-repeat groups. Saved references remain
provisional during authoring and must resolve before frozen validation. This is
not a native-format inference; native projections and staged load restrictions
remain unchanged.

Every occurrence reuses the bounded gRPC executor for unary, server-streaming,
client-streaming and bidirectional calls. The complete response and terminal
status are observed before extraction, assertion and the iteration's tail
condition. Existing stream status behavior (including expected non-OK status),
message limits, deadlines and cancellation remain intact; no retries or live
session replay are introduced. Conditions read committed scopes only after the
whole iteration. Extraction publishes only a complete accepted batch; ordinary
failures retain existing failurePolicy semantics, while an uncertain commit
stops before a tail decision or another RPC and never replays the completed
response.

Executor and per-run metadata/TLS credentials are checked for every potentially
enabled leaf before earlier HTTP work or scripts, including leaves under false
IF conditions. Disabled ancestry does not require per-run credentials but still
undergoes static validation. Credentials stay keyed by frozen leaf IDs and are
not persisted in receipts or backups. Owner, canonical MCP HTTP/stdio and CLI
continue to share the frozen graph and receipts.

The pure `plan-repeat-until-grpc-model` suite covers admission intersections;
`plan-repeat-until-grpc-workflow` uses loopback gRPC/HTTP peers for execution and
entrypoint evidence. Loopback evidence is not a claim of external-service
interoperability. The admission RED baseline is the exact PR #146 head
`2021566bc780d0b1c3e95b8dbc9dac8bc5f3001d`; no native format, runtime-row
capability or transport implementation change is part of this extension.


### gRPC runtime-row extension

At the gRPC milestone canonical runtime rows also admitted independent `grpc` leaves through the same
control capability intersection. See [the runtime-row gRPC contract](ADR-PLAN-RUNTIME-ROWS-GRPC.md).
At that milestone SSE, Socket.IO, database leaves and `protocol` aliases remained rejected inside
rows, even under disabled or false branches. This extension supersedes only the
gRPC row exclusions above; historical evidence remains scoped to its milestone.


### Socket.IO repeat-until extension

Canonical `repeat.untilCondition` also admits independent `socketio` leaves. This
is not a `protocol` alias or native-format compatibility claim. At that milestone SSE and database
leaves remained excluded; the SSE extension below supersedes only the SSE until exclusion. At this repeat-until milestone runtime-row ancestors still rejected Socket.IO in either
nesting direction, including false IF branches and disabled definitions; the runtime-row extension below supersedes that exclusion. Native
projection, staged load and all count, depth, request, decision and wait budgets
remain unchanged. Saved definition references resolve before frozen validation.

Each occurrence uses a fresh bounded Socket.IO flow with the existing v2/v4,
WebSocket/polling/auto transport and emit/wait/ack contracts. ACK success retains
all arguments; sent and ack-sent mean only local completion with unknown remote
business outcome. Timeout or disconnect retains bounded partial command/event
evidence without automatically replaying an emit or ACK. No synthetic HTTP
status or Socket.IO script dialect is introduced. Whole-step deadlines,
truncation, cancellation and terminal session cleanup retain their contracts.
HTTP steps can use their existing scripts to consume extracted values.

The independent executor and ephemeral auth/query/header/TLS bindings are
preflighted for potentially enabled leaves before earlier work, including false
IF branches. Bindings use stable frozen leaf IDs, not occurrence IDs, and are not
stored as credential configuration in snapshots or receipts. Peer response data
remains untrusted and may itself contain sensitive content. Disabled ancestry retains static validation but
does not require live credentials. Extraction and assertions use completed
accepted results; tail conditions run after the body, observing committed scopes.
An uncertain scope commit fail-stops before another condition or occurrence and
preserves completed transport evidence without claiming an acknowledged commit.

The focused Socket.IO model suite checks capability intersections, references,
script rejection and unchanged budgets. Real loopback workflows cover v2/v4 WebSocket,
polling and auto through owner HTTP, MCP HTTP/stdio, CLI and restore; distinct
occurrence/session identities, early exit, internal timeout/disconnect partial
evidence under stop and continue, explicit expected failure, cancellation,
preflight, HTTP scripts, durable extraction, scope/journal uncertainty and no replay.
These workflows are separate
transport evidence, not a claim of proprietary-format or external-service
interoperability. The integration base is PR #149 head
`cd7f9649789022d5bc58823b5bafea3a41cdcfea`, preserving the Socket.IO peer-diagnostic
safety fix on top of the PR #148 capability foundation.


### Socket.IO runtime-row extension

Canonical runtime rows now admit independent `socketio` leaves in either nesting
order with until and IF. See [the Socket.IO runtime-row contract](ADR-PLAN-RUNTIME-ROWS-SOCKETIO.md)
for row freezing, persistent scopes, transient credential preflight, partial ACK
outcomes, cancellation and unknown-commit fail-stop. At that milestone SSE and database
descendants remained excluded; the SSE runtime-row extension below supersedes the SSE exclusion. This changes admission only and retains PR #149 diagnostic safety;
legitimate event and ACK payloads may echo sensitive data and are not redacted.


### SSE repeat-until extension

Canonical `repeat.untilCondition` admits `protocol` leaves with frozen `sse`
definitions, including nested IF, fixed-repeat and until groups. This narrowly
extends the exact PR #151 head `f981d31555a71b7891e846f8ca5d2f5d4ae99c4b`.
At that milestone runtime-row ancestors or descendants rejected SSE, including disabled
and false branches; the runtime-row extension below supersedes that exclusion. Staged load and native projections remain rejected. Count,
depth, expanded request/decision, delay and evidence limits are unchanged.
Saved references remain provisional until resolved and checked as frozen data.

Each occurrence performs one fresh bounded capture through the existing SSE
transport. EOF is `completed`; duration and event-count boundaries are `partial`.
`expectedStatus` defaults to `completed`, so accepting partial results requires
an explicit `expectedStatus: "partial"`. Only matching status and passing
assertions allow extraction. The transport HTTP handshake status is not the
capture completion status. Incomplete final events are discarded. Cancellation
rejects and closes the stream; failure/cancellation do not promise to retain
buffered events. No parser state, event ID, retry field, or connection is reused
between occurrences, and no reconnect or automatic retry is introduced.

GET and POST retain their existing wire contract. **A repeated POST can repeat
remote side effects**; reaching a capture boundary or failing an assertion does
not prove the remote operation did not occur. This is a bounded control loop,
not an idempotent retry facility. Tail conditions observe confirmed scopes after
the body; continue policy can reach a tail decision after a failed capture, but
failed extraction never publishes a partial batch or promotes a previous result
into new event evidence. Stop policy stops before that decision. Unknown scope
commit always fail-stops before another body leaf, tail decision, wait or sibling,
with retry unsafe and completed transport evidence retained.

Potential active leaves preflight executor authority and all required temporary
header credentials before earlier HTTP work, including false IF branches.
Disabled ancestry still validates definitions but does not require live bindings.
Credentials remain keyed by stable leaf IDs, not occurrence IDs, and are not
saved as configuration in snapshots, receipts or backups. Event data can itself
contain sensitive content and is not claimed to be redacted. Existing append
failure/unknown-commit receipts preserve no-replay and no-stale-data behavior.

The SSE graph and injected-control tests cover intersections, references,
unchanged limits and explicit evidence-budget/commit boundaries. The dedicated
loopback workflow suite covers owner HTTP, official MCP HTTP/stdio and CLI,
EOF/timeout/caps, expected status, stop/continue, preflight, cancellation, nested
occurrences, restore/restart and persistence receipts. Loopback tests do not
claim external-service interoperability or proprietary-format parity.

### SSE runtime-row extension

Canonical runtime rows now admit SSE descendants under nested IF, fixed and until
controls. See [the SSE runtime-row contract](ADR-PLAN-RUNTIME-ROWS-SSE.md). This
extends admission only, with frozen rows, persistent committed scopes, preflight
and all transport boundaries unchanged. Database and noncanonical aliases remain excluded.
