# HTTP MCP gRPC bidirectional sessions

The independent stdio extension is described in
[stdio bidi sessions](ADR-MCP-STDIO-GRPC-BIDI-SESSIONS.md). The HTTP-only
scope below records the original slice and does not imply cross-process authority.

## Deliberately small first slice

In the original HTTP-only slice, six tools expose saved bidirectional streaming definitions:
`start_grpc_session`, `get_grpc_session`, `send_grpc_session`,
`half_close_grpc_session`, `cancel_grpc_session`, and `get_grpc_operation`
(all prefixed with `localapi_`). Both write and execute grants are required.
Unary, client-only streaming, server-only streaming and stateless calls are rejected.
Stdio was excluded from this original HTTP slice; its subsequent support and
independent authority are specified in the stdio ADR linked above. Existing finite gRPC tools and owner interactive APIs remain.

Start accepts only a project, saved definition ID and operation ID. It freezes
the saved schema, target and method. There are no temporary targets, script hooks,
metadata/TLS overrides or credential parameters. Saved gRPC definitions do not
store credentials: services needing required metadata, a custom CA or client
certificate are outside this first slice. Required metadata policy is not
bypassed. Standard authenticated TLS verification remains enabled.

## Ownership and bounds

The HTTP host injects the registry's private owner object; JSON cannot choose an
owner. Sessions bind to that owner epoch and project. Start/send/half-close
recheck live ownership and current unarchived project state after asynchronous
reads. DELETE, authorization changes, logical expiry and host shutdown revoke
admission synchronously, cancel owned streams, and drain initiated work and its
one automatic save. Archiving a project cancels only that project's streams.
Physical HTTP socket loss is not logical ownership termination.

The adapter shares the existing owner `GrpcSessions` and `GrpcSlots`: five active
gRPC calls across owner/MCP, finite execution and interactive streams. It does
not create a second quota pool. Fifty retained sessions is the existing bound;
failed or unknown saved evidence is not evicted to admit more sessions. Active
slots are released at transport termination, independent of persistence outcome.

Saved timeoutMs remains the absolute total deadline, 50–30000 ms (default 5000).
There is no renew tool and reads do not extend it. Deadline guards apply before
submission and when callbacks/events arrive, not only when the timer runs.
Per-direction limits remain 100 messages and one MiB, including the existing
request JSON and protobuf-wire accounting.

## Operations and backpressure

Start/send/half-close reserve operation IDs before asynchronous reads or network
side effects. Same ID and exact content returns the existing state without
replay; different content is rejected. Each owner has 200 gRPC operation slots,
with no eviction. This is process-local deduplication, not crash recovery or
remote exactly-once delivery. A new ID is not evidence that retrying is safe.

Only one operation may await connection admission or local completion. A write
requires both its successful callback and backpressure drain (unless write
returned true) before `locally-written`. Half-close refuses a pending write and
requires end's local completion before `half-closed`; it closes only the request
direction, not the response stream. Neither local completion means remote
acceptance. Final successful RPC status still depends on existing gRPC terminal
state validation, not readable end alone.

Operation states are pending, started, locally-written, half-closed,
failed-before-submit or unknown. Manager validation and quota refusals are failed-before-submit. A trusted marker
after atomic slot acquisition and immediately before client construction marks
the network boundary; there is no separate check-then-act quota preflight. Transport errors,
termination and uncertain completion never cause resend/reconnect. Pending
operations become unknown on terminal cleanup; late callbacks cannot revise
frozen evidence. Receipts explicitly keep remoteConfirmed and retrySafe false.

## Reads, cancellation and persistence

Get returns bounded status and a response-message page, at most twenty entries.
`afterMessage` is a one-based sequence cursor (zero starts at the first entry).
Each entry includes sequence, JSON byte count and SHA-256 hash. JSON no longer
than 4096 UTF-16 code units is returned as `message`; larger entries return only
a bounded `preview` and truncated=true, without splitting a surrogate pair.
This is not a lossless export. No complete request array or transport credentials
are echoed; response content and remote status details can themselves be sensitive.

Cancel waits for the original persistence attempt. Repeated cancel and owner
cleanup never implicitly retry storage; the existing owner storage-only
reconciliation remains available separately. Failed and uncertain commits remain
failed/unknown until confirmed; a lost response never proves a network action was
unsent. Shutdown can wait on stalled persistence and abrupt process loss can lose
unsaved evidence. No background retry or cross-process ownership is added.
