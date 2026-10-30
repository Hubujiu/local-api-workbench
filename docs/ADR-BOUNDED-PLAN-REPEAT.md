# Bounded canonical plan repeat groups (WIP)

This is a Workbench control-flow extension, not an importer for native
`automated_testings`. Legal, previously extracted static materials establish a
native fixed-count loop, but not the complete saved automation graph/paid-service
contract. No original executable, license flow or proprietary implementation is
used. The pure dependency join contains PR41 (including PR30/17), PR42, PR43
(frozen inheritance consumers/native MCP), PR28 (native task failure policy and
source validation/export guards), PR2 (explicit CLI database grants), and PR19
(bounded/cancellable MCP transport). It contains neither this feature nor the
backend integration branch as ancestors. This joins existing consumers without
reverting PR43 engine/budget fixes or importing newer XML feature work.

## Definition and freeze contract

A top-level step may be `{type:"repeat", id, name, enabled, count, steps}`.
`count` is a literal integer 1..100. `steps` is a nonempty array of ordinary HTTP
steps or TCP protocol leaves (TCP extension acceptance pending below); nested
groups and other protocol leaves are unsupported. Unknown group fields,
accessors, invalid identifiers/counts, duplicate node IDs and malformed leaves
reject before execution. IDs are stable definition identities. Missing IDs are
assigned on initial normalization, not during an execution of a saved plan.

The existing 200-step limit is also the maximum potential expanded leaf count.
Disabled groups and children remain fully validated and count toward this budget;
they produce no HTTP request or successful result. Enabling a node cannot bypass
preflight. Existing plans without repeat groups retain their current contract.
Repeat plans also have a 4MiB frozen-definition limit and a 4MiB logical expanded
configuration limit (sum of each serialized leaf times its count, including
disabled definitions). Validation precedes occurrence construction; occurrences
hold references rather than cloning all future requests. Dynamic URLs/responses
still fail through the existing leaf runtime, not a fictitious all-error preflight.

All group leaves are frozen through the same service/auth/parameter resolver as
ordinary steps, before any execution. The stored snapshot and hash retain the
repeat intent, not just an expanded list. Freezing fixes request configuration,
not runtime values of environment/global variable placeholders. Each actual
repeated result keeps its leaf stepId and an occurrence identity containing
groupId, childId and zero-based iteration. Occurrences do not mutate definitions.

## Execution and persistence contract

Groups run serially, in definition order. Runtime/environment/global scopes and
cookies continue across leaves and iterations, exactly as ordinary plan steps.
This is not the isolated-iteration load runner. Existing ordinary failure
continuation and atomic extraction semantics stay unchanged. The inherited native-task runtime keeps strict extraction failure as a stop for
all remaining iterations and trailing steps; the first successful iteration
remains committed.
Cancellation starts no later leaf and does not imply rollback of completed
network operations or confirmed scope commits. There is no automatic retry.

Final evidence uses the existing bounded save receipts: execution status remains
distinct from recordSaved; typed unknown remains unknown and does not authorize
replaying the group. Backup/restore preserves the graph and validates it again.
Native directory export and native MCP flow create/update/view/execute reject
unsupported repeat nodes rather than flatten them. Native flow lists and filtered
execution-history/result projections reject repeat-containing results rather than
dropping occurrence identities; canonical history/result tools remain available.
CLI grants scan only enabled definitions once, not once per iteration; subsequent
queries retain the existing invocation-scoped grants and per-query/per-stage
limits. CLI grants have no total TTL or total-call-count field; no such policy is
introduced or claimed by repetition. Stored graph
bindings and provenance are validated through child definitions, including on
restore; only an exact same-project stored frozen leaf can be reused without a
live graph binding. Existing write/execute permissions are unchanged.

No while, conditions, datasets, parallelism, nested loops, new frontend, changed
script budget, or original native automation compatibility is included.

## Acceptance status

The initial specification commit intentionally contains RED real-HTTP tests for
repeat execution and preflight. It is a saved work-in-progress, not acceptance.
Final acceptance must cover login → repeated extraction/consumption → final
request, failure/atomicity/cancel, owner/MCP/CLI, project isolation, frozen live
edits, backup/restart, and generic/typed-unknown saves without network replay.

The next coherent stage passes those ordinary HTTP workflows through owner HTTP,
the official MCP SDK HTTP and real stdio subprocess, CLI and restarted/restored
Store. An actual held response is cancelled in iteration two; only four started
occurrences are recorded, with no following request. Real malformed-history
pre-journal and ordinary-file post-journal obstacles retain completed wire results
and truthful distinct receipts; repair/recovery does not send any new request.
The specification's two RED tests now pass. Original linear plan/protocol and
HTTP atomic extraction regressions also pass in focused batches.

The expanded independent base additionally verifies native strict extraction in
iteration two stopping all later HTTP, exact grants through a real CLI subprocess
and SQLite then HTTP, no-grant restart rejection, native projection/export
rejection without mutation, and stored inheritance leaf reuse after restore.
No root combination is represented by these standalone tests.

## Repeat-only evidence growth and output

Serialized completed leaf records are accumulated as UTF-8 bytes. Once this
exceeds 8MiB, the runner checks before the next occurrence and stops without
starting it. The final real record is retained unchanged. `status:failed`,
`stopReason:"evidence-limit"`, and `evidenceBudget` identify the executed count,
remaining count and last/next occurrence. No unexecuted result is synthesized.
If the threshold is crossed only by the final leaf, there is no evidence-limit
failure. Cancellation and strict native extraction failure take precedence.

This is **not an 8MiB hard output limit**: one existing bounded leaf record may
cross the threshold, and snapshots/variables/envelopes add bytes. Existing HTTP
response and script budgets are not raised; ordinary linear plans do not acquire
this new stop rule. Store uses the same save receipt and journal limits as before.
Owner HTTP/CLI retain full available evidence; CLI stdout has no new hard size cap.
The existing MCP stdio 8MiB serialized-frame limit may reject the full output
**after execution and saving**. Its bounded error says to inspect history and not
replay. Canonical history includes a small stop summary and run ID; a too-large
full result may still require owner HTTP or on-disk evidence access. Such an
output error never means the network did not run, nor grants permission to retry.

Exact-head CI and root composition remain pending; local focused acceptance is
not a claim that all backend modules or native automation formats are complete.

## Ordinary linear step identity correction (pending CI)

This follow-up fixes a pre-existing canonical linear-plan defect also present
before repeat groups: two ordinary steps could use the same ID, overwrite one
provenance-map entry, match the wrong prior step during edits, and emit ambiguous
result step IDs. It is not a repeat regression or native automation mapping.

A separate pure identity helper validates all ordinary steps, including disabled
ones, before old-step matching, snapshot creation, execution, Store normalization
or backup restoration. An explicit ID is a well-formed nonempty string of at most
200 UTF-16 code units, unique within the plan, excluding `__proto__`, `prototype`
and `constructor`. Other opaque IDs such as `toString` remain legal; old
provenance lookup uses own keys rather than inherited Object properties. Missing
or empty-string IDs retain their creation meaning: allocate an identity once,
check it against all explicit/generated IDs, and never replace a valid existing
ID. Null, booleans and numbers are not missing IDs.

The direct raw `runPlan` API retains missing/empty-ID compatibility. It validates
the whole input first and assigns only first identities in its private clone;
it does not renormalize requests, mutate the input, or renumber saved IDs.
Duplicate or otherwise invalid explicit IDs fail before any request, script,
credential lookup or scope commit. Existing repeat validation, IDs, limits and
native MCP guards are unchanged. Empty plan drafts remain valid definitions but
still cannot execute.

New/updated/restored configurations and full project saves reject invalid
ordinary identities rather than silently repairing them. All ordinary plans in
a Store save are preflighted before collection normalization. Existing on-disk
bad definitions and their history remain readable; executing or resaving the bad
definition is refused until an explicit repair. Historical `runs`, their
`snapshot` and `results` are not rewritten or newly subjected to this definition
rule; backup/restore retains their old identities and hashes exactly. A historical
record can therefore remain ambiguous; this change does not invent its identity
or claim to verify its original hash.

Local evidence is restricted to the new pure helper tests and syntax/format/diff
checks. The new workflow specifications cover real owner HTTP, official SDK HTTP
and stdio, CLI, same-target/different-ID execution, frozen live edits, provenance,
full saves, project isolation, persisted results, backup/restart, whole-batch
rejection and read-only historical evidence. They have not been run locally and
require exact-head ordinary CI. No application/VM/XML/database/pressure workload,
original client, new permissions, runtime budget, dependency or bundle change is
part of this correction. Prior failures and acceptance evidence above remain
historical and are not replaced by these pending specifications.

## TCP repeat extension — contract stage (not accepted)

The next bounded slice admits TCP `protocol` leaves alongside HTTP inside one
repeat group. WS, SSE, gRPC, Socket.IO and nested groups remain rejected there.
This is canonical Workbench control flow, not original automation compatibility.
Project definition references are resolved before the final TCP-only snapshot
check. Saved definitions and occurrence identities remain immutable across live
protocol edits/deletion. Each occurrence uses the existing one-shot wire executor;
there is no shared socket, new retry, executor, resource budget or credential kind.
Temporary credentials bind to unique leaf definition IDs, never occurrence IDs;
TCP continues to reject nonempty authentication configuration. Disabled groups
remain structurally validated and counted against all existing potential-work
limits, but do not trigger active handshake preflight or network calls.

The feature branch's existing EOF/first-data completion is sufficient for this
slice. Delimiter behavior belongs to the later root composition, not a partial
PR12 backport. Protocol extraction keeps its ordinary atomic-batch and failure
continuation semantics, not native-task strict-extraction stop semantics.

Acceptance must cover real TCP-to-HTTP values per iteration, frozen references,
live edit/deletion, unique occurrence identities, project isolation, atomic
extraction failure, second-iteration cancellation/deadline, typed uncertain save
receipts without resend, owner HTTP, canonical MCP HTTP/stdio, CLI, and
backup/restore/restart. Native adapters must still reject lossy repeat projection.
No application/network/VM/database workflow is run locally; ordinary exact-head CI
is required. This contract stage is not implementation or acceptance evidence.

TCP implementation stage: repeat/group and leaf-wrapper unknown fields reject.
Protocol definition fields retain the existing `normalizeProtocol` semantics;
this change does not introduce a second definition-field schema or claim that
all unknown definition keys reject. Pure graph-helper tests pass locally; network
workflows and exact-head CI remain pending, so this is not acceptance.

`tests/plan-repeat-tcp-workflow.test.mjs` now specifies the TCP extension's real
owner/canonical HTTP/stdio/CLI, frozen edit/deletion, actual owner backup/restore,
restart, malformed/unauthorized zero-connection paths, atomic extraction with
continuation, owner cancellation and direct run signal deadline, and genuine
post-journal recovery workflows. The deadline case tests the run signal, not a
claim about an owner HTTP transport deadline. Static review, syntax and format
checks pass; these application workflows have deliberately not run locally and
remain pending ordinary exact-head CI. Existing HTTP repeat evidence and any
later root composition evidence must not be substituted for these new flows.

Root-only composition additionally specifies two delimiter-completed TCP leaves
inside the group, each extracting its full frame into the following HTTP leaf.
The peer does not send EOF; saved delimiter/endpoint survive live edits. A real
post-journal uncertainty case retains delimiter frames and occurrence evidence
through recovery without another connection. This combines existing PR12 and
PR44 behavior only in integration; no delimiter implementation was backported to
PR44. These root workflows are syntax/static checked, awaiting exact-head CI.
## WS/SSE repeat contract (work in progress)

The next bounded slice admits `websocket` and `sse` protocol leaves beside TCP
and HTTP in the same single-level canonical repeat. It reuses the existing wire
executor, not a new transport. Nested repeat, gRPC and Socket.IO remain excluded;
all existing expansion, configuration, evidence and transport limits remain.
Definition references resolve before frozen validation; disabled definitions are
still validated and budgeted. Native export continues to reject repeat.

Temporary credentials bind to stable leaf IDs, never occurrence IDs. All active
wire leaves require their declared handshake headers before any plan network
side effect, including an earlier HTTP step. Disabled leaves need no required
header, but supplied credential maps remain validated. WS supports existing WSS
CA and paired client certificate/key with certificate verification mandatory.
SSE only accepts temporary headers: custom TLS is unsupported, not silently
ignored. Credentials are not part of the saved plan, run configuration or backup.
This is not a promise to redact arbitrary secrets echoed by a remote server.

Each occurrence opens a fresh WS socket or SSE stream/parser; event IDs, retry
metadata, response buffers and limits do not leak across occurrences. There is
no implicit SSE reconnect. Canonical variables intentionally carry forward;
extraction is atomic per batch, not an implicit variable reset per iteration.
Ordinary protocol extraction failure retains its existing continuation policy.
Message/event limits and timeouts produce partial outcomes, not completed ones.
Abort must close the active transport and prevent the next leaf/iteration.

Acceptance requires real WS/SSE-to-HTTP values, frozen references despite live
edits/deletion, owner HTTP/official SDK HTTP+stdio/CLI, credential preflight and
concurrent isolation, bounded outcomes, cancellation/deadline, backup/restore/
restart, and unknown journal outcome recovery without replay. Local static and
pure graph checks alone are not acceptance; whole workflows await ordinary CI.
Root-only send-empty options and TCP delimiter support are not backported here.

Root WS/SSE composition additionally specifies the existing `sendEmptyMessage`
option through two actual empty WS frames per run, downstream extraction,
live-definition edits, backup/restore/restart, and renewed credential preflight.
It preserves the root wire snapshot option guard and TCP delimiter workflows;
these existing root options are not added to PR44's older feature dependency base.
This is a test specification pending exact-root CI, not an executed acceptance.
