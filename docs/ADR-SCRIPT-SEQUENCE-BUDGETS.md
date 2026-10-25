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
