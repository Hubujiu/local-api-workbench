# Bounded HTTP MCP WebSocket interaction

This records the original HTTP slice. For the subsequent independent stdio host
and its distinct authorization/revocation boundaries, see
[stdio WebSocket sessions](ADR-MCP-STDIO-WEBSOCKET-SESSIONS.md).


This first slice supports an adaptive challenge/response workflow on one saved
WebSocket connection. It is not a new arbitrary network target API, a stdio
session broker, a gRPC API, or a script execution engine.

## Admission and authority

Six `localapi_*_websocket_*` tools are advertised only by the HTTP host with
both write and execute grants. Every call requires an allowed `projectId` and
an initialized logical MCP HTTP session. The host supplies an object identity
owned by that particular session registry and authorization epoch. Session IDs
in arguments, JSON data, and bearer-token possession do not substitute for this
object. Each connection additionally belongs to exactly one project.

`start_websocket_session` accepts a saved `definitionId` and `operationId` only.
It freezes the saved definition and existing scalar variable context using the
same preparation path as the owner interactive endpoint. It does not accept
URL, headers, TLS, subprotocol, environment, script, or default-message overrides.
It opens the connection but does not send the definition's default message.
`send_websocket_session` requires explicit well-formed text, at most 1 MiB after
existing template resolution. Structured/binary outgoing payloads are outside
this first slice. Received binary data retains its existing base64 evidence.
Unknown definition behavior is rejected rather than silently ignored. Saved definitions with an explicit
`sendEmptyMessage` field are also rejected, whether `true` or `false`: that
finite-capture policy is not silently discarded or treated as an initial-send
instruction. This first slice never auto-sends a saved default message. An
explicit empty string in the send tool remains a supported text message.

## Ownership, leases and shutdown

Owner and MCP interactions share the same `ProtocolSessions` instance: five
connecting/open connections and fifty retained sessions. Unsaved terminal
project evidence is not discarded to free slots. This does **not** combine the
separate pre-existing finite protocol-call pool into a global five-call quota.
Existing 8 MiB cumulative data, 200 retained events, 3 MiB stored record, and
15-minute absolute lifetime limits are unchanged.

An additional 60-second lease starts with each connection. Only the explicit
`renew_websocket_session` tool renews it; reading, sending, querying an operation,
and HTTP keepalive do not. Renewal never extends the absolute 15-minute bound.
Timer expiry closes without waiting for another call. A terminal connection
cannot be renewed or resumed. Logical HTTP sessions retain their own bounded
idle lifetime.

DELETE, logical HTTP expiry, authorization-epoch changes, token rotation and
shutdown synchronously revoke new admission, close owned sockets, and drain
already initiated work and persistence. An owner project archive revokes only
that project across affected HTTP owners, including pending starts. Other
projects keep their connections. Unarchiving alone does not restore a grant.
After explicit reauthorization, the same logical HTTP session receives a new
owner epoch and may start a new connection; old sockets never revive. That
explicit configuration change retains the existing global epoch revocation
semantics, unlike the project-targeted archive operation. Global authorization
changes still revoke the old epoch. The ordinary owner API remains authoritative over its connections.

A physical HTTP connection closing or a lost reply is **not** logical session
termination. The server does not reconnect or replay. The client can query its
operation using a new JSON-RPC request ID while its logical session remains
valid. An abandoned connection is eventually closed by its lease.

## Bounded in-process operation ledger

Start and send reserve an operation ID before asynchronous project lookup.
IDs are scoped to the live owner epoch; the project, action and exact arguments
are part of a hashed fingerprint. Same ID and content returns the recorded
operation, never a second network action. Different content is rejected. Each
owner has at most 200 operation IDs, retained until ownership ends; filling the
ledger rejects new start/send but permits reading, stopping and renewing.
JSON-RPC IDs remain distinct and cannot be reused under the existing transport
contract.

Only one unconfirmed MCP send may be pending on a connection. A concurrent new
send is rejected, not queued. States are:

- `pending`: awaiting admission or local send callback; do not replay.
- `started`: a session was allocated, not proof of successful handshake. Read it.
- `locally-written`: local transport callback succeeded, not remote acceptance.
- `failed-before-submit`: this operation did not reach transport submission.
- `unknown`: transport submission/completion cannot safely be established.

A start failure inside manager admission is conservatively `unknown`, including
quota refusal; this does not assert any bytes were sent. Stop, close or a send
callback error makes a submitted but unconfirmed send `unknown`. Late callbacks
cannot revise frozen terminal evidence. The ledger is process-local, not a
cross-crash exactly-once mechanism. New IDs or new logical sessions do not prove
that retrying an earlier unknown action is safe. No automatic resend exists.

## Receipts, storage and bounded reads

`get_websocket_session` returns a page of at most twenty events, each with at
most 4096 UTF-16 code units of display text (never half a surrogate pair).
`afterEvent` uses monotonic event sequence numbers. Full original byte counts,
SHA-256 hashes, encoding, truncation, dropped-before-page count and `hasMore`
make omitted data explicit. This page is not a lossless archive and is well
below the existing 8 MiB MCP frame ceiling. Credentials/configuration are not
included in these receipts; received/sent application content may itself be
sensitive and is not redacted.

`stop_websocket_session` waits for the one automatic persistence attempt and
reports its receipt. Repeating stop never sends or reconnects and does not
silently retry storage. Existing owner storage-only recovery remains available.
A failed save is not described as a successful execution record. Abrupt process
loss can lose unsaved events and the operation ledger. DELETE drains persistence
but has no receipt body; stored protocol history and the owner API are the
remaining evidence after logical ownership is removed.

Stored protocol records keep the existing `manual`/`deadline`/`remote`/`error`
close reasons. MCP receipts separately expose `ownershipCloseReason` for lease,
archive and logical-ownership termination. No historical record schema is
loosened. No dependency, network security policy or sandbox budget is changed.

## Verification scope

Synthetic loopback WebSocket and official MCP HTTP SDK tests cover same-socket
nonce response, start/send deduplication, cross-owner/project refusal, DELETE
and authorization revocation, targeted archive, persisted terminal history and
the shared owner quota. Unit/controlled transport tests cover pending-store
revocation, lease timers/renewal/absolute bounds, bounded event pages, ledger
capacity, unknown outcomes, late callbacks and storage-drain uncertainty.
These tests do not establish remote application-level acceptance, crash
recovery, stdio ownership, or cross-process quotas.
