# Project-scoped TCP/WebSocket/SSE execution evidence

The project protocol execution API now records one-shot TCP/WebSocket/SSE attempts in the existing bounded protocol history, alongside gRPC and Socket.IO. It can execute an explicit request or a saved project-local definition. Selecting a definition forbids endpoint replacement; a missing/foreign ID fails before networking. Message overrides are frozen in that execution's definition snapshot rather than changing the saved definition. Explicit invalid messages are rejected, not replaced with a saved payload.

## Record and status contract

Each record has its own record ID, the active cancellation run ID, transport type, timestamps/duration, frozen definition, effective bounded options, outgoing byte hash where applicable, result hash and outcome. Definition/result hashes use order-independent canonical JSON; they detect accidental alteration, not cryptographic proof of an external peer or genuine execution of user-imported records.

- completed means the capture ended without an observed failure or sampling boundary. It is not a functional test pass or remote business acceptance.
- partial means a duration/event-count boundary was reached. WebSocket count limits now explicitly set `limited`, like SSE.
- failed preserves an execution error, or a complete TCP reply that fails the requested ISO8583 decoder.
- cancelled records explicit cancellation. It does not assert that a remote side effect was undone.

TCP stores exact base64/size rather than a redundant potentially lossy text copy, plus optional verified ISO decoding or decode error. SSE stores parsed events; WebSocket stores encoded messages and native completion metadata. ISO decoded evidence is checked against the frozen profile and raw bytes. Every record is capped at 3 MiB, and the existing project history retains the most recent fifty records. Corrupt definitions, hashes, event shapes, statuses and restores fail validation.

Authentication Header values and TLS private material are excluded from the definition snapshot. WebSocket options retain requested subprotocols, header names only, and a default/custom-CA/mTLS mode marker, not authentication values. Payloads, endpoint query strings and remote response content can still be sensitive and must be reviewed before export or sharing. This is not a blanket secret scrubber.

## Persistence and failure

A successful network operation returns its real result even when recording fails, with recordSaved=false, recordId=null and persistenceError. Network errors retain the existing error HTTP status and report whether their failed/cancelled evidence was saved. No persistence or decoding failure automatically repeats the network operation. Oversized serialized evidence is explicitly unsaved, not silently truncated or called complete.

The history participates in normal project reload and backup/restore. Restoring history does not reconnect any transport. Existing global interactive diagnostic sessions are not silently made persistent or project-owned; this change concerns project one-shot executions only.

## Read interfaces

GET project protocol-runs returns the project's protocol history, optionally filtered by transport type. The MCP read-only tools localapi_list_protocol_runs and localapi_get_protocol_run respect the same project allowlist. Lists return summaries without message bodies; details require a recordId. Neither tool enables execution or replays a request.

Acceptance uses actual TCP, WebSocket and SSE fixtures; saved-definition execution; partial/failed/cancelled outcomes; reload/restore; canonical key-order tolerance; corrupt-restore atomicity; credential-configuration exclusion; project-scoped MCP reads; fifty-record retention after actual network calls; and storage failure/oversized evidence without replay. Existing full and cross-platform gates remain required. No frontend was added.
