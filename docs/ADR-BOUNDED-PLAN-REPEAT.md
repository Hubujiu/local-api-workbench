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
steps; nested groups and protocol leaves are unsupported. Unknown group fields,
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
