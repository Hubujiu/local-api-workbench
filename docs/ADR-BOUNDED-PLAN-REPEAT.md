# Bounded canonical plan repeat groups (WIP)

This is a Workbench control-flow extension, not an importer for native
`automated_testings`. Legal, previously extracted static materials establish a
native fixed-count loop, but not the complete saved automation graph/paid-service
contract. No original executable, license flow or proprietary implementation is
used. The feature depends only on PR41 (including PR30/17) and PR42; the pure
dependency join does not contain the backend integration branch.

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
continuation and atomic extraction semantics stay unchanged. In the combined
native-task runtime, strict extraction failure still stops the remaining run.
Cancellation starts no later leaf and does not imply rollback of completed
network operations or confirmed scope commits. There is no automatic retry.

Final evidence uses the existing bounded save receipts: execution status remains
distinct from recordSaved; typed unknown remains unknown and does not authorize
replaying the group. Backup/restore preserves the graph and validates it again.
Native writers/adapters must reject unsupported repeat nodes rather than flatten
them or silently discard children. They are separately composed when absent from
this minimal dependency base. Existing write/execute permissions are unchanged.

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

This remains WIP: exact-head CI, native consumer guards/leaf-aware grant and
restore adapters, combined strict native extraction, and aggregate result-growth
policy still require completion. No root combination is represented by these
standalone tests, and no unimplemented native export path is called supported.
