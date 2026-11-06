# Canonical SSE children in runtime row plans

Canonical runtime rows (`rowsFrom`, `maxRows`) admit frozen `protocol` leaves
with type `sse`, alongside HTTP, TCP, WebSocket, gRPC and Socket.IO. Admission
intersects every enclosing IF, fixed-repeat and until control, even when disabled
or false. Saved references resolve before freezing. The base is exact PR #153
head `600f29b0bf47bba6d11299d6b172c2ae10bd3915`. No new transport, dependency,
native format, script dialect, reconnect or automatic retry is introduced.

The complete source array and row-dependent operands validate before the first
child. Each entered frame freezes its rows even if extraction replaces the source.
Row fields are not implicit interpolation variables: canonical scripts read
`pm.iterationData` and explicitly bind values. This is not full row isolation.
Accepted runtime/environment/global changes persist across children and rows;
nested IF and until conditions observe confirmed scopes and the frozen row.

Each occurrence performs a fresh bounded capture. EOF is `completed`, including
when an incomplete trailing event is discarded. Duration and maxEvents boundaries
are `partial`; default expectation remains completed and partial acceptance must
be explicit. Expected-status and assertions gate atomic extraction. Failure or
abort retains the existing failed/cancelled diagnostic contract, not a promise of
buffered-event preservation. Parser state, retry fields and Last-Event-ID do not
carry over, and sockets close at termination.

**Explicit repeated POST occurrences can repeat remote side effects.** A partial
capture, assertion failure or cancellation does not mean the server did nothing.
This is a control loop, not an idempotent retry facility. Ordinary failures obey
stop/continue; uncertain scope commit always fail-stops before any later body,
condition, wait or row, with completed transport evidence retained and no replay.

Potential enabled leaves preflight executor and stable leaf-ID credentials before
earlier scripts or HTTP, including empty arrays and false branches. Disabled
ancestry still validates definitions. Credentials are transient configuration,
not persisted into snapshots or receipts. Event payloads can echo sensitive data;
no blanket payload redaction is claimed.

Depth, request/control count, row bytes, delays and evidence quotas are unchanged.
Staged load stays HTTP-only, and native projections/write restrictions stay closed.
Unit and real loopback owner/MCP HTTP/stdio/CLI evidence live in
`plan-runtime-rows-sse*.test.mjs`. Local fixtures establish canonical behavior,
not proprietary format parity or external-service interoperability.
