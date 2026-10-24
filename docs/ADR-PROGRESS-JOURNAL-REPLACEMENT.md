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
