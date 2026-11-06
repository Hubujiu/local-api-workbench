# Canonical Socket.IO children in runtime row plans

Canonical runtime rows (`rowsFrom`, `maxRows`) admit independent `socketio` leaves
alongside HTTP, TCP, WebSocket and gRPC. The capability intersects every enclosing
IF, fixed-repeat and repeat-until control, including disabled definitions and
false branches. SSE, database and `protocol` aliases for Socket.IO remain excluded.
Saved references must resolve before frozen validation. This extends admission
on exact PR #150 head `bd57ba40cc88d9f6472c700804a10480d4fc3c27`; it does not add a
transport, native format, script dialect, retry, reconnect or session replay.

The whole runtime source array and row-dependent conditions validate before the
first child executes. The entered frame is frozen even if extraction replaces
its source. Row fields are not implicit interpolation variables: an existing HTTP
script can read `pm.iterationData` and bind variables for Socket.IO commands.
This is not full row isolation. Accepted runtime/environment/global changes
persist into later steps and rows, and nested until/IF conditions observe committed
scopes and the frozen row. Socket.IO leaves still reject scripts.

Each occurrence runs a fresh bounded v2/v4 flow with existing websocket, polling
and auto transport behavior. The complete command result is available before
extraction or later children execute. ACKs preserve all arguments; `sent` and
`ack-sent` confirm local completion only, not the remote business outcome.
Timeout/disconnect preserve partial command and event evidence. Extraction remains
an atomic batch and follows expected-status and assertion acceptance. Ordinary
failures follow stop/continue; unknown scope-commit outcomes fail-stop under either
policy, before another condition or row, with no automatic replay. Cancellation,
whole-step deadlines, truncation and terminal cleanup retain their contracts.

All potentially enabled leaves require independent executor and transient
header/query/auth/TLS preflight before earlier work, even when rows will be empty
or IF will be false. Credentials use frozen leaf IDs, not occurrence IDs, and are
not persisted as configuration. Disabled ancestry retains static validation but
does not require execution credentials. PR #149's diagnostic-only safety remains:
peer error diagnostics are hidden, including when credentials are present, without trusting
peer-controlled message/data/description fields or only exact-secret matching.
This is not blanket payload redaction. Legitimate event or ACK payloads may echo
credentials and remain untrusted business response data in receipts; callers must
not assume echoed sensitive data is removed.

Staged load stays HTTP-only. Native projections and native-write restrictions stay
closed. Depth, expanded request/control, row byte, wait and evidence limits are
unchanged. Owner, canonical MCP HTTP/stdio and CLI retain the same graph and durable
receipt machinery. Unit/model boundaries and real loopback workflow tests live in
`plan-runtime-rows-socketio*.test.mjs`. Local fixture evidence is not a claim of
proprietary-format or external-service interoperability.
