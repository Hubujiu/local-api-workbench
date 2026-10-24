# Project-scoped Socket.IO backend sessions

## Reuse and supported boundary

Static inspection of the original transport adapter identifies Socket.IO connect/send/event-update entrypoints. Use MIT-licensed socket.io-client 4.8.4 for production and socket.io 4.8.4 for independent fixture servers, not a hand-written Engine.IO/Socket.IO wire implementation. Dependency audit is a separate release gate; static original-app findings are not proof of behavioral equivalence.

This backend supports Socket.IO v4 over WebSocket, bounded HTTP long-polling, or official polling-to-WebSocket upgrade. WebSocket remains the compatibility default; a saved definition can explicitly select polling or auto. Reuse the MIT-licensed engine.io-client 6.6.7 transport extension points and state machine. The polling adapter replaces only HTTP acquisition with the Node HTTP(S) stack and bounded reads, rather than rewriting Engine.IO or Socket.IO framing.

Older Socket.IO/Engine.IO revisions, reconnection policy and native Apipost Socket.IO data migration remain outside this milestone. Static original-wrapper research also shows different TLS/retry defaults; this implementation deliberately retains certificate verification and no automatic retry rather than copying those defaults. No frontend is added.

## Definitions, sessions and credentials

Authenticated local project APIs:

- GET/POST/DELETE `socketio-definitions`: persist bounded ID/name, HTTP(S) namespace URL, transport path, optional transport selection and event filter. No embedded URL credentials/query or auth/header/TLS material is stored.
- POST `socketio-sessions`: connect a saved definition with optional request-scoped auth, query, headers, TLS CA/client key/cert and connection timeout. Target/path overrides are refused.
- GET `socketio-sessions` or `socketio-sessions/:id`: inspect only this project's sessions.
- POST `socketio-sessions/:id/send`: emit an event with JSON/binary args and optional acknowledgment timeout.
- POST `socketio-sessions/:id/ack`: explicitly acknowledge a server-requested event once, using its expiring ackId.
- POST `socketio-sessions/:id/watch`: change local event filtering; null captures all, an empty array captures none. This does not claim to subscribe/unsubscribe a remote application topic.
- POST `socketio-sessions/:id/stop`: close and persist final evidence. GET `socketio-runs` reads saved snapshots.

Each session owns a fresh non-multiplexed client. Automatic reconnect and emission retry are disabled. TLS hostname/chain verification remains enabled; only bounded CA/key/cert inputs are accepted. Auth/query/header options remain in the live transport only. On closure the retained session drops its transport reference and listeners. Project session IDs cannot be read, sent to, acknowledged or stopped through another project. Importing/saving a definition never connects.

## Observable results and limits

The backend distinguishes connecting/open/closed/error. An emitted event without an ack has unknown remote outcome. Ack timeout or disconnect also has unknown remote outcome: it is never automatically replayed. Ack success preserves all callback arguments. JSON values and explicit `{ "$binary": "canonical base64" }` preserve binary data without evaluating source. Reserved Socket.IO lifecycle event names and unsafe/oversized payloads are refused.

At most five live Socket.IO sessions and 50 retained session records exist per application process. Sessions close after 15 minutes. Connection/ack timeouts are 50–30000 ms. WebSocket maxPayload is 1 MiB and compression is disabled; application messages are also limited to 1 MiB and bounded structure. The upstream parser bounds binary attachments. The cumulative session event budget is 8 MiB and 10000 events, retained evidence is at most 200 events/2 MiB, and truncation is explicit. Pending server ack handles are limited to 100 and expire after 30 seconds.

Stopped snapshots persist in the existing protocol history with a frozen definition and events. Concurrent stop calls share a single storage operation. A disk failure returns `recordSaved:false` and the actual closed snapshot; a subsequent stop retries storage only, not any network action. Configuration saves preserve concurrent activity; backup/restore retains evidence. Live sessions and unfinalized events are not crash-durable, and shutdown does not invent a completed record. A session's passed/failed classification is lifecycle evidence, not a guarantee that unacknowledged remote application effects succeeded. Application payloads or remote error messages can still contain sensitive data; credential omission is not universal redaction.

## Acceptance

Independent local servers cover namespace/custom path and auth, JSON/binary multi-argument acknowledgments, explicit one-use server acknowledgments, ack timeout with one observed side effect, no reconnect after server disconnect, strict mTLS, oversized-frame rejection, project isolation, five-session limits and release, filtering, bounded/truncated retention, token/Origin checks, definition save, finalized history reload/backup, concurrent configuration saves, and injected storage failure followed by idempotent storage-only retry.

References: [official client API](https://socket.io/docs/v4/client-api/), [official client options](https://socket.io/docs/v4/client-options/), [Socket.IO source](https://github.com/socketio/socket.io).

## Fixed plans, MCP and CLI

Plans accept a discriminated `type: "socketio"` step containing a frozen definition and up to 100 declarative `emit`, `wait` and `ack` commands, with a single 50–30000 ms whole-step deadline. Saving a project-local definitionId freezes its contents; importing or saving never connects. Unsupported fields/scripts are rejected. Explicit waits must be compatible with the definition's event filter. A sequence cursor permits an event received while an emit acknowledgment is pending to satisfy the following wait without consuming stale events. An ack command acknowledges only the immediately relevant waited server event and cannot replay an ack handle.

HTTP runs and both MCP flow execution tools support temporary `socketioCredentials`, keyed by a unique Socket.IO step ID. Only auth/query/headers/TLS fields are accepted, all bindings are preflight-validated before any plan step executes, and no credential binding enters snapshots, variables or history. Existing write-plus-execute grants and project allowlists remain required. Read-only MCP tools list/get definitions without connecting. HTTP-hosted MCP, manual plans and interactive sessions share the same five-live-session manager. Standalone MCP shares its own manager; the CLI runs anonymous saved flows without a credential input flag.

The native `socketioResult` retains command outcomes and bounded events; no HTTP status is fabricated. Default expected status is passed, independent of the HTTP strict-200 policy. Assertions and JSON extraction operate on the command result array and can feed a following HTTP step. Sent/ack-sent outcomes remain explicitly unknown remote outcomes; a passing plan means its declared local actions and waits succeeded, not that unacknowledged remote business effects are proven. Ack timeout, connection failure and whole-step timeout fail the step without replay. Cancellation and every terminal path close the transport. Command results are capped at 2 MiB in addition to session limits; omitted command output sets resultTruncated and the overall truncated flag, with a failed outcome rather than a complete-result claim.

Plan evidence is saved through the existing history mechanism, with actual results returned when storage fails and no network retry. Acceptance covers real Socket.IO-to-HTTP extraction, server-initiated acknowledgments, stale-event avoidance, overall timeout, cancellation, strict validation/no-capability refusal, HTTP/MCP shared saturation and recovery, scoped temporary credentials, CLI execution, a newly restored project's reloaded evidence, and persistence-failure non-replay. Frontend support and native source migration are still not claimed.

## Bounded polling and handshake validation

The default Node polling implementation accumulates response bytes before application delivery. The adapter instead enforces 1 MiB request/response bodies during acquisition, 16 KiB request URLs and response headers, at most 20 pending HTTP requests per process, a 30-second whole-request deadline and a 2-second bound for a best-effort closing request. It does not follow redirects or decompress unsolicited encodings. Pending ordinary requests abort when the transport closes; closing packets can finish within their shorter bound. No implicit cookie jar is enabled. Caller credentials remain per-session; protocol-owned headers and Engine.IO query parameters cannot be overridden.

Both WebSocket and polling validate decoded open packets before the upstream handshake handler: bounded well-formed SID, a bounded string-array upgrade list, finite bounded heartbeat settings and a positive safe payload limit. Duplicate opens are refused. The client payload budget is clamped to the smaller of the server limit and 1 MiB. This prevents malformed metadata from reaching an unbounded upstream loop or malformed-URI path, without changing the official codecs. Polling failures are promises, including URI-construction failures, rather than uncaught synchronous exceptions.

Acceptance includes real polling namespace/auth/binary acknowledgments, real mTLS and a single successful upgrade, finalized/new-copy storage through fixed plans, pending-handshake cancellation, server-side disconnect and Engine.IO client cleanup, response-byte interruption before the complete oversized body, malformed UTF-8, oversized declarations, unsolicited compression, refusal of redirects/HTTP denial without fallback, and the 20-request acquisition cap. A deliberately malformed upgrade-list object reproduced a child-process hang before the handshake guard; the same bounded subprocess case now terminates normally with a client error on both transports. Resource failures never trigger an authentication bypass, a replay or a TLS-verification exception.
