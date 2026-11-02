# Bounded SQLite process failure diagnostics

CI40239943970 / Windows job121309387190 failed the existing SQLite write test at
head4788331 with SQLITE_WRITE_OUTCOME_UNKNOWN. The log did not reveal whether
startup, execution, IPC or exit failed. This change supplies evidence; it does
not assert the intermittent failure has been fixed or retry an unknown mutation.

Parent and independent supervisor retain their 2000ms hard deadlines, the
16MiB process / 64MiB execution worker memory limits, owned-process termination
and parent-disconnect protection. Progress does not reset timers. Successful
result delivery unrefs, rather than removes, the child deadline, so it does not
keep a completed process alive but still bounds leftover handles. No SQL runs a
second time to obtain a result.

A fixed set of typed IPC stages separates OS spawn, supervisor receipt, worker
online, module-ready, worker result/exit/error and completed result delivery.
Only a valid completed-result envelope AND process close with exit0 AND no
parent timeout/process fault can succeed. Status messages alone cannot succeed;
a result followed by a hung process remains an unknown write outcome.

Failures carry bounded structured diagnostics: last observed stage, elapsed and
checkpoint milliseconds, timeout flag, exit code/signal, result receipt and
allowlisted spawn/process/send/worker error codes. No raw error message/stack,
SQL, parameters, database path, credentials or child stderr are added. Existing
raw process error causes are replaced by code-only causes. Ordinary SQL error
responses retain their existing semantics. Absence of a ready event means only
that it was not observed, not proof that the worker never started.

Real subprocess tests copy the unchanged parent/supervisor source into private
temporary directories with independent fixture children. They cover status-only
IPC, worker exception/nonzero exit, startup without readiness, result followed by
hang, serialization failure, sensitive sentinel redaction, one execution/no
retry, ordinary completion and bounded diagnostics. Existing real SQLite native
read/write timeout, journal recovery, parent disconnection and supervisor-only
termination tests remain enabled, with no weakened limits. No production test
switch or environment-controlled injection is introduced.

OS-level fork failure and resource-driven synchronous Worker constructor failure
have safe handling but are not claimed reproduced by the test fixtures. Exact
Windows/macOS/Linux CI remains required; diagnostics cannot retroactively prove
the cause of the earlier failure. No merge into main or deployment.

## HTTP and packaged failure visibility

Initial PR16 Windows desktop smoke also reached the database-write phase and
received the same unknown-write message (CI40243242788/job121319339103); installs,
startup and preceding read succeeded. Its isolated develop base did not contain
this diagnostics PR. Similar symptoms do not establish the same cause.

Authenticated SQLite HTTP errors now include the error code and a reconstructed
fixed diagnostic allowlist. The packaged desktop smoke logs only those sanitized
fields for database failures, not arbitrary response bodies, SQL or paths. A real
HTTP write timeout exercises this boundary and verifies journal recovery by a
subsequent read, never a retry of the mutation. Missing authorization still gets
403 without database execution. The parent timeout flag is not proof about the
independent child watchdog or other external termination.

## Test-only failure-phase visibility

Windows CI40650351379 again reported `SQLITE_WRITE_OUTCOME_UNKNOWN` in the
existing timeout/recovery test, but TAP omitted the Error's diagnostics. The
expected initial timeout is caught inside its child and returned as JSON; a
later independent write is a plausible failure location, not an established
root cause. Identical earlier source/tests passed, which does not resolve this
unknown outcome or justify replaying a write.

The test now labels the existing expected-timeout child, recovery open/read,
post-recovery read, independent write and final read phases. On failure only,
a test helper appends a `SQLITE_PHASE_METADATA` suffix of at most 2048 bytes,
using fixed phase labels and the existing production diagnostic whitelist fed
by inert own-data snapshots. Proxies, accessors, arbitrary nested values and
serialization hooks are not inspected or invoked. The original Error is
rethrown; code, cause, stack descriptor/call sites and assertion fields are not
rewritten. A lazy native stack may reflect the annotated message header when
first rendered; the helper never invokes the stack getter. Unsupported or
frozen errors pass through unchanged. Only the added suffix is redacted: the
original message remains intact and is not claimed to be sanitized.

This is diagnostic-only, not a root-cause fix. Production source, SQL, operation
count/order, assertions, deadlines, memory limits, signals, cleanup and no-retry
semantics are unchanged. Local verification uses only fake Errors/Promise
callbacks and a tiny fake-error TAP child, plus syntax/format checks; it does
not run SQLite/native/database workloads. Exact-commit CI must establish the
next result; an old CI rerun cannot validate this change.

## Bounded operation-stage evidence (not a root-cause fix)

Windows desktop job124714254611 / CI41261066003 at root eb63e640 reached
worker-ready at 76ms, then reported an unknown write after parent timeout and
SIGKILL at 2086ms without a result. Its native SQLite closure and desktop smoke
were byte-identical to the prior accepted root. This does not locate a stalled
native operation, prove no commit, or justify replay. The original 30s smoke
assertion was not satisfied and its independent readback was never reached.

Writes now emit a bounded diagnostic side channel around validation, read-only
probe open/close, write open, BEGIN, prepare, step, change-count checks, COMMIT,
rollback and close. There are no per-row events, extra SQL calls or readbacks.
The worker measures integer elapsed milliseconds from its first operation
observation with a monotonic clock; these are not host elapsed timestamps.
Worker, supervisor and host each independently admit at most 16 attempts,
including rejected traffic, and accept only three own-data envelope fields,
known stages, bounded integer times and a forward subsequence of a fixed
acyclic state graph. Missing events are allowed; repeated, backward and
post-commit rollback events are rejected. Only the last accepted stage and
elapsed value are retained. The HTTP/CI boundary reconstructs those two fields;
no SQL, parameters, paths, credentials, messages or stacks are added.

Every operation-stage envelope remains diagnostic-only even if malformed or
containing result-shaped fields. It cannot fall through to the result channel.
Any stage, including commit-complete, may be followed by timeout or failed
process close: it never upgrades an unknown write to success. The existing
completed envelope + exit0 + no timeout/process fault condition is unchanged.
Both 2000ms timers, 16/64MiB limits, disconnect termination, SQL order,
transaction/finally behavior and no-replay semantics remain unchanged. Observer
validation, clock and send failures are swallowed and cannot substitute their
own exception for a SQL result/error. No timer is reset or extended.

Local verification is limited to syntax, formatting and reviewed pure helper
tests. Real subprocess/Worker, SQLite and packaged desktop execution remains
ordinary exact-commit CI only. CI fixtures cover stage-only and result-smuggling
envelopes, secrets/invalid Unicode, nonmonotonic or excessive traffic, one
execution followed by a hung worker after commit-stage, unchanged invalid-mode
errors and throwing-observer commit/rollback behavior. Existing native tests,
success assertions and deadlines remain required. This is evidence gathering,
not a performance/root-cause fix; a later green run cannot establish why the
historical write failed. No recovery write or failure-time readback was added.
