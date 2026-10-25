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
