# Explicit script sequence budgets

## Defect and contract

`runScriptSequence(stages, input, options)` previously replaced caller-supplied
budgets with default maxima. A caller requesting zero HTTP operations could
therefore still issue a request, and a smaller active or wall deadline was
silently ignored. Invalid options also passed through empty sequences.

Single scripts and sequences now share one budget validator. A sequence starts
with the validated requested values and decrements those same budgets across
all scopes. A zero operation quota is valid and prohibits that operation.
The active and wall budgets must be positive, finite and within the existing
250 ms / 2000 ms maxima. All existing operation maxima are unchanged. Omitted
options keep their old defaults; no new GUI option or execution authority is
introduced. Reported activity is consumed time relative to the requested
starting budget, not relative to a hardcoded 250 ms.

## Evidence and limits

Regression fixtures first failed on the old implementation: reduced activity
budget became 250 ms, zero network quota permitted real loopback HTTP, reduced
cross-scope quotas were reset, and invalid empty-sequence options were accepted.
The tests exercise actual isolated workers and a local HTTP server, check zero
or exactly one observed network request, and retain completed-request evidence
when a later scope exhausts its quota. Existing sequence timeout, cancellation,
isolation and default-quota regressions remain in place.

This fixes explicit option enforcement. It does not establish a root-cause
repair for previously observed intermittent bootstrap, callback or total-wall
failures, and does not relax time limits to hide those failures.

## Intermittent initialization timeout diagnostics (2026-10-25)

Integration commit 78a96753 failed the macOS visualizer-size and XML-DTD safety
checks in CI 40211041861: expected input rejection was replaced by a script timeout.
One failure reported compatibility wall time 212ms inside the unchanged 250ms
activity budget. The diagnostic rerun passed, and a local paired 24-invocation probe
also passed (compatibility wall median 9ms, maximum 11ms). Neither result proves a
root cause or justifies calling the intermittent timeout fixed. Failure logs and
assertions are retained.

The worker now reports per-operation thread CPU microseconds alongside existing
wall-clock milliseconds. CPU readings are diagnostics only: they are never used
for budget admission, replenishment, interruption or cancellation. All 250ms/2s
caps, lower caller limits, cumulative quotas, fresh workers and rejection checks
remain unchanged. CPU diagnostics propagate through errors and completed sequence
stages; absent host support yields an empty diagnostic object, not a changed policy.
No process API is exposed inside QuickJS. Node documents the units and current-thread
scope at https://nodejs.org/api/process.html#processthreadcpuusagepreviousvalue .

This change improves the next failure's evidence; it is not a performance fix or
proof that CI scheduling caused the observed timeout.
