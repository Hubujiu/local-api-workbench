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

## Terminal serialization budget enforcement (2026-10-27)

A single-script completion previously charged serialization, QuickJS-to-host
string conversion and host JSON parsing in `activityMs`, but returned success
without checking that final charge. Native JSON/string operations can finish
between QuickJS interrupt checks. Ordinary bounded output reproduced the gap:
`pm.variables.set("payload", "x".repeat(900000))` returned 27/27/30 ms under
three explicit 20 ms budgets, while staying below the 1 MiB output cap. A formal
regression first failed with 33 ms returned for a 16 ms budget. This is a real
completion-contract defect, not an assertion that prior CI timeouts had this cause.

The worker now checks the exact final charged `activityMs` before publishing a
success outcome. Exceeding the requested budget takes the existing error and
cleanup path; no successful variables, scopes or response overrides escape.
The limit remains active wall time, not CPU, with the same 250 ms / 2 s / 16 MiB
maxima. No counters are replenished and no serialization or asynchronous safety
check is removed. Existing quota and serialization-content errors retain their
checks and messages. The fix does not claim preemption of host native operations;
it rejects a late result rather than accepting it.

The regression uses normal isolated workers and several explicitly reduced
budgets. Scheduling can cause an earlier legitimate timeout, or a sufficiently
fast machine can finish within budget; every success must satisfy the charged
activity invariant, and timeout is not accepted as proof of content validation.
Separate default-budget success, output-size/circular-value rejection, sequence
failure and fresh-worker isolation checks retain their specific expectations.
Initial focused validation: 10/10 terminal and sequence budget cases pass. Broader
related checks and exact platform CI remain pending at this checkpoint.

## Failure observability, not a runtime repair

Root commit 6c238a4181dc898ddaebded7c5dd7b4881b702f0 / run40551216982
failed the cumulative-quota scope assertion on macOS (project instead of request).
The old assertion did not expose which quota variant or the underlying error,
so its cause remains unknown. The regression now includes the synthetic quota,
error and existing accounting metadata in assertion failures. It does not log
source/variables/credentials, add workloads, change any assertion expectation,
run a new VM probe, or relax runtime/worker/CI limits. All original quota, phase
and completed-scope assertions remain mandatory; an earlier timeout is not
accepted as quota validation. No diagnostic success can retroactively fix or
reclassify the old failed commit. Ordinary CI on a later commit can provide
useful evidence if the failure recurs; this change itself is not a root-cause fix.

## Monotonic elapsed-wall accounting (2026-10-31)

Static review found an independent clock defect: host `Date.now()` differences
could become negative after a civil-clock adjustment, replenishing the remaining
active budget. A forward adjustment could instead cause an early timeout. Worker
bootstrap/activity interrupts, debits, serialization charges and timer scheduling
now share captured `performance.now()` elapsed time. Guest `Date.now()` and built-in
variable timestamps retain civil-clock semantics. Parent sequence accounting
already uses monotonic time.

The 250 ms active elapsed-wall / 2 s outer caps, lower requested limits, fresh
workers, memory/stack limits, operation quotas, cancellation and all pending-task,
Promise-rejection and terminal-serialization checks remain unchanged. Scheduling
pauses inside measured operations still consume activity; async idle waits still
do not. CPU remains diagnostic only. Budget admission, debits and final activity
are fractional and never rounded; only emitted phase/bootstrap diagnostic totals
are rounded to integer milliseconds for the existing public-field whitelists.

Pure fake-clock observation tests cover fractional diagnostic totals and unchanged
public validation; static wiring checks cover host/guest clock separation and
unrounded charging. These do not execute a VM or prove runtime interruption.
Existing real CI budget, timer, callback, sequence, serialization and XML rejection
assertions remain required on the exact new commit. No local application, VM or
XML workload was run for this change. There is no evidence that clock adjustment
caused the previously observed CI timeout, and this hardening does not establish
that timeout's root cause or accept timeout as content-validation success.

## Keep diagnostic sampling outside active work (2026-11-17)

Two deterministic accounting defects were found while investigating PR264's
macOS timer-quota failure in run44107589801, job134124057422. That failure reached
the second scope's function-library boundary before its timer loop ran. The
compatibility breakdown observed 162 ms for evaluation and 7,914 microseconds of
thread CPU. The observer started that wall interval before taking its initial
CPU sample, so these figures do not isolate VM evaluation from diagnostic
sampling. They do not prove that a particular system call or runner suspension
caused the historical failure. The first and second macOS runs also used different
Node patch versions and runner images; they are not a controlled comparison.

The compatibility block set its active deadline before diagnostic CPU sampling
and computed its remaining allowance after the final sample. Serialization
similarly included its final CPU sample in the terminal active charge. These
special paths differed from ordinary script/callback segments, whose existing
`bounded` helper already separated active work from CPU observations. A trusted
observer pause could therefore consume the guest allowance and change a valid
result into a timeout, despite performing no guest or conversion work.

The subprocess regression injects a fixed 300 ms pause only inside the real
worker's CPU observer. On the unmodified 87d673ec baseline, the 60+60 timer fixture
fails before the second scope issues a timer, instead of reaching the required
100-timer shared limit. A separate pause in the final serialization CPU sample
incorrectly rejects a valid 900,000-character output. Both positive regressions
fail on that baseline. These are deliberate fault injections, not reruns accepted
after a failure; no production switch enables them.

Compatibility now uses the same fractional remaining allowance across three
bounded work segments: eager Mock installation, compatibility source construction,
and VM evaluation. CPU sampling and phase observers surround those segments. No
remaining time is restored between them or between sequence scopes. The complete
existing Mock asset read, manifest parse and integrity check charge is retained.
Serialization charges its actual VM evaluation, string extraction, host JSON
parse, native assertion evidence reconciliation and final size checks in one
bounded segment. The final over-budget publication guard remains mandatory.

The review also reproduced an adjacent undercharge: native assertion evidence
was evaluated inside a bounded segment but converted to a host string and parsed
outside it. A fixed 300 ms delay in that host parse still returned success with
about 25 ms reported activity. Evidence evaluation, conversion, parsing and handle
disposal now share one bounded segment, with `finally` disposal if conversion
throws. The same delayed parse now exhausts the allowance and prevents result
publication at the next budget boundary. That boundary is not evidence that the
following serialization operation performed the slow work.

The activity metrics exclude their own CPU start/finish samples; serialization's
metric now includes its complete charged conversion tail. The compatibility
phase observer also starts its wall interval after its own CPU start sample.
Phase windows can still surround other diagnostic bookkeeping and are observation
data, not debit inputs; do not sum them with activity metrics or treat them as CPU
measurements. Actual debits continue to use monotonic elapsed wall time, never CPU
time. Scheduling pauses within actual work still consume that allowance.

The default and lower requested 250 ms active / 2 s total limits, fresh workers,
16 MiB VM memory, 512 KiB VM stack, timer/network/Faker/assertion quotas, async idle
policy and cancellation remain unchanged. The host total deadline still includes
all diagnostic delay: a blocked observer is terminated by the same default 2 s
deadline. The regressions also require a real infinite guest loop to be
interrupted, a delayed host serialization parse to reject, and native evidence
conversion to reject after consuming its active allowance. No XML boundary or
quota assertion is weakened, and no CPU-based replacement clock is introduced.

Local validation on Node24.22.1: all 72 cases pass across 11 targeted files,
including all six subprocess accounting cases, the unchanged XML boundary
fixtures, stage quotas, explicit lower budgets, final output guards, CPU/phase
diagnostics and native response assertions. The original baseline's two observer
cases fail, and the pre-fix evidence-conversion case fails by returning an
incorrect success. There are no accepted retries, skipped cases or raised limits.

The historical PR264 failures remain failures. Repairing this reproducible
coupling and conversion undercharge does not prove the unique cause of every
previous intermittent timeout, or establish cross-platform acceptance before
the exact repaired commit finishes CI. Bootstrap accounting and unrelated
network reply preparation are outside this focused change.
