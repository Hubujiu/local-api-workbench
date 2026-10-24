# Project-scoped Socket.IO backend sessions

## Reuse and supported boundary

Static inspection of the original transport adapter identifies Socket.IO connect/send/event-update entrypoints. Use MIT-licensed socket.io-client 4.8.4 for production and socket.io 4.8.4 for independent fixture servers, not a hand-written Engine.IO/Socket.IO wire implementation. Dependency audit is a separate release gate; static original-app findings are not proof of behavioral equivalence.

This backend milestone uses the WebSocket transport of Socket.IO v4, with namespace URLs and a separate Engine.IO path. It is not a generic WebSocket client. HTTP long-polling is explicitly rejected in this milestone: the default Node XHR adapter accumulates response bytes before delivering them to the application, so an application event limit would not establish a bounded transport response. No silent fallback to an unbounded transport is permitted. Older Socket.IO/Engine.IO revisions, reconnection policy, plan/MCP execution and native Apipost Socket.IO data migration remain outside this milestone. No frontend is added.

## Definitions, sessions and credentials

Authenticated local project APIs:

- GET/POST/DELETE `socketio-definitions`: persist bounded ID/name, HTTP(S) namespace URL, transport path and optional event filter. No embedded URL credentials/query or auth/header/TLS material is stored.
- POST `socketio-sessions`: connect a saved definition with optional request-scoped auth, query, headers, TLS CA/client key/cert and connection timeout. Target/path overrides are refused.
- GET `socketio-sessions` or `socketio-sessions/:id`: inspect only this project's sessions.
- POST `socketio-sessions/:id/send`: emit an event with JSON/binary args and optional acknowledgment timeout.
- POST `socketio-sessions/:id/ack`: explicitly acknowledge a server-requested event once, using its expiring ackId.
- POST `socketio-sessions/:id/watch`: change local event filtering; null captures all, an empty array captures none. This does not claim to subscribe/unsubscribe a remote application topic.
- POST `socketio-sessions/:id/stop`: close and persist final evidence. GET `socketio-runs` reads saved snapshots.

Each session owns a fresh non-multiplexed client. Automatic reconnect and emission retry are disabled. TLS hostname/chain verification remains enabled; only bounded CA/key/cert inputs are accepted. Auth/query/header options remain in the live transport only. On closure the retained session drops its transport reference and listeners. Project session IDs cannot be read, sent to, acknowledged or stopped through another project. Importing/saving a definition never connects.

## Observable results and limits

The backend distinguishes connecting/open/closed/error. An emitted event without an ack has unknown remote outcome. Ack timeout or disconnect also has unknown remote outcome: it is never automatically replayed. Ack success preserves all callback arguments. JSON values and explicit `{ "$binary": "canonical base64" }` preserve binary data without evaluating source. Reserved Socket.IO lifecycle event names and unsafe/oversized payloads are refused.

At most five live Socket.IO sessions and 50 retained session records exist per application process. Sessions close after 15 minutes. Connection/ack timeouts are 50–30000 ms. WebSocket maxPayload is 1 MiB and compression is disabled; application messages are also limited to 1 MiB and bounded structure. The upstream parser bounds binary attachments. The cumulative session event budget is 8 MiB, retained evidence is at most 200 events/2 MiB, and truncation is explicit. Pending server ack handles are limited to 100 and expire after 30 seconds.

Stopped snapshots persist in the existing protocol history with a frozen definition and events. Concurrent stop calls share a single storage operation. A disk failure returns `recordSaved:false` and the actual closed snapshot; a subsequent stop retries storage only, not any network action. Configuration saves preserve concurrent activity; backup/restore retains evidence. Live sessions and unfinalized events are not crash-durable, and shutdown does not invent a completed record. A session's passed/failed classification is lifecycle evidence, not a guarantee that unacknowledged remote application effects succeeded. Application payloads or remote error messages can still contain sensitive data; credential omission is not universal redaction.

## Acceptance

Independent local servers cover namespace/custom path and auth, JSON/binary multi-argument acknowledgments, explicit one-use server acknowledgments, ack timeout with one observed side effect, no reconnect after server disconnect, strict mTLS, oversized-frame rejection, project isolation, five-session limits and release, filtering, bounded/truncated retention, token/Origin checks, definition save, finalized history reload/backup, concurrent configuration saves, and injected storage failure followed by idempotent storage-only retry.

References: [official client API](https://socket.io/docs/v4/client-api/), [official client options](https://socket.io/docs/v4/client-options/), [Socket.IO source](https://github.com/socketio/socket.io).
