# Monotonic reflection and Socket.IO acknowledgement lifetimes

The reflection aggregate timeout and Socket.IO's internal acknowledgement window
previously used the adjustable civil clock. Clock rollback could enlarge the
reflection remainder or retain acknowledgement eligibility past thirty seconds;
forward jumps could prematurely reject negotiation or acknowledgements. These
findings concern host elapsed windows, not real-world timestamps.

Reflection now captures `performance.now()` for its aggregate start/deadline and
completion comparison. The remaining per-call allowance is floored, never rounded
up or clamped to a positive minimum. The existing less-than-50-ms rejection remains:
`executeGrpc` accepts integer 50..30000 ms, so a remainder below 50 cannot safely
start a transport. A caller's 50 ms budget may therefore expire before admission;
it is not replenished to manufacture an admissible call. Input validation, query
limits, cancellation, version negotiation and error semantics are unchanged.
Reported duration remains nonnegative integer milliseconds; observations alone are
rounded. The external gRPC SDK's absolute `Date` deadline and independent relative
cancellation timer are deliberately unchanged.

Socket.IO uses the same captured monotonic source for pending acknowledgement due
times, pruning and eligibility checks. Thirty seconds and the 100-pending limit are
unchanged, as are project/session identity, connection state, single-use handling,
remote-outcome evidence, transport limits and cleanup. Event/session ISO timestamps
remain civil time. No authentication, cookie or token expiration code changes.

The new serial CI fixture exercises real loopback reflection version negotiation
across forward/backward civil jumps, requiring exactly two calls and successful
service discovery. The Socket.IO fixture accepts an immediate acknowledgement
across a forward jump, then actually waits over thirty seconds after receiving 100
pending events before proving rollback cannot preserve eligibility. A fresh event
must prune the expired entries before the unchanged cap and remain acknowledgeable.
There is no shortened production window or injected monotonic clock. Civil-clock
patches restore in `finally`, replies have bounded fixture waits, and fixtures close
servers/sessions. Existing protocol tests remain intact.

Local verification only parses source, checks formatting and executes a source-only
wiring test. No local gRPC, Socket.IO, HTTP, application or VM workload is executed.
Real protocol results await exact-commit ordinary CI; these authored regressions
are not already verified end-to-end evidence. Nothing here establishes the cause
or resolution of the separate XML/script timeout.
