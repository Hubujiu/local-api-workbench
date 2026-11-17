# Bounded Windows progress journal replacement

The stdio MCP activity journal is written to a unique temporary file and then
renamed over its previous version. A Windows CI failure returned EPERM from this
rename after the first request, aborting the execution plan. The specific holder
of the conflicting handle is not established by that log.

Only this journal replacement now retries Windows EPERM, EACCES, or EBUSY, with
five attempts and waits of 10, 20, 40, and 80 milliseconds. This bounds scheduled
backoff, not the duration of an operating-system call. The same source and target
are used each time. The previous journal is never deleted or truncated, no ACLs
or permissions are changed, and no network request or plan step is retried.
Permanent failures still propagate the original error after the bound. Other
platforms and error codes fail immediately. The caller retains serialized writes
and cleanup of its own temporary file.

Injected contention tests verify the previous file remains readable until the
successful atomic replacement, delay and attempt bounds, and failure identity.
The existing real stdio progress test remains unchanged and runs on all supported
CI operating systems. Injected tests alone do not establish which process held a
Windows handle or prove every Windows filesystem failure is transient.

## Preserve completed execution evidence on permanent failure

The journal still propagates its original failure and does not retry any request.
The plan boundary now catches a rejected step-progress observer only after the
completed step has been recorded. It stops before any later step, marks the run
failed with the fixed `EXECUTION_PROGRESS_FAILED` diagnostic and
`retry_safe: false`, and returns the completed response for normal history/run
persistence. The diagnostic contains no underlying filesystem path or error
message. A completed step keeps its actual transport/assertion outcome; external
cancellation still takes precedence for the overall run status.

A permanently broken activity path also prevents final activity persistence.
For compatibility the stdio client still receives the existing single generic
RPC error, not a new receipt format. This is not permission to replay: after
repairing the activity path, a separately authorized client can list and read
the exact saved execution. Persistence itself can still fail independently and
must not be claimed successful solely because a network response completed.

The regression uses a real loopback peer and a test-owned temporary directory:
after activity creation, the peer replaces the activity directory with a regular
file before returning its response. Actual filesystem ENOTDIR errors stop the
second request while the first response and committed environment extraction
remain recoverable. Both 200 and 503 responses are covered through official SDK
stdio API/flow calls, process restart, authorized readback and cross-project
denial, with no script execution or mocked filesystem failure.
