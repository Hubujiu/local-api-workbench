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
