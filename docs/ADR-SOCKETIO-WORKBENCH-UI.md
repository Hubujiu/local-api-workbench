# Socket.IO workbench

This slice makes the existing Socket.IO saved definitions and owner session endpoints accessible in the GUI. It is not a WebSocket alias. People explicitly save a definition, supply temporary connection credentials, connect, inspect the actual state, send an event with a JSON argument array and optional acknowledgement deadline, read events, and stop/save the terminal record. Version 4 and legacy version 2 settings reuse existing backend admission; no new transport or compatibility claim.

## Authority and effects

Definitions use the normal whole-project CAS save and reconciliation guard, not the older unversioned definitions writer. Other dirty project drafts are never implicitly saved. A definition contains only name, URL/namespace, Engine.IO path, watched events, version, transport and any existing handshake contract. Temporary auth/query/headers/TLS CA/client certificate/private key are not copied to definitions, snapshots or project history. Leaving the panel clears those input fields, but an existing server connection may continue to hold its original credentials until it is stopped.

No connection, send, reconnection, retry, acknowledgement or storage retry is automatic. GET/list is observation only. Selecting a listed session is explicit, not proof that it came from a lost start response. An uncertain start blocks another start; an uncertain send blocks another send to that session. A same-tab sessionStorage ledger contains only session identifiers and uncertainty flags, never endpoints, definitions, events or credentials. Intent evidence is stored before new effects; storage failure blocks new connection/send dispatch. Safety stop remains allowed if recovery storage fails, with an explicit warning that refresh can lose that evidence. It is not an idempotency key and does not provide cross-tab or server-restart recovery guarantees.

The backend start endpoint has no deduplication intent and initially returns `connecting`, not proof of an open transport. Per-view synchronous gates prevent duplicate click dispatch; a lost result is not retried. Backend memory retention is bounded and can evict terminal sessions. A missing session does not prove that nothing was sent. Reloaded identifiers are unverified until an explicit GET; no reload automatically resumes connections or events.

## Evidence and stop

`sent`, `ack-timeout` and `disconnected` retain unknown remote outcome. `acknowledged` is an application acknowledgement, not remote business exactly-once. Stop can run while a send acknowledgement is pending, and does not retract an already-sent event. Late results cannot overwrite newer project/editor state; uncertain delivery remains visible even after stop. Exact frozen session definitions must match the selected saved definition before sending.

Explicit stop freezes and persists the terminal record. HTTP 200 can still contain `recordSaved:false`; the actual session/remote evidence remains separate from recording success. GET does not imply save or repair a failed record. Server auto-timeout/transport failure alone does not save this record; people must explicitly stop/save while the session remains retained. A repeated explicit stop may retry record persistence according to the existing backend; no automatic stop retry is made. The GUI labels this action accordingly.

Events, ack values and definition addresses may contain sensitive business data and are displayed and can enter history. They are not redacted by this slice. Temporary credential isolation is not a claim that the whole record is secret-free. Incoming events that request an ack display their evidence, but manual incoming-ack responses are not implemented in this slice.

## Acceptance

Use disposable loopback Socket.IO fixtures only. Verify real definition save/reload, connect/read state, echo acknowledgement, unknown acknowledgement with no replay, stop/persist, credential isolation and stale response ownership through the actual browser and server. Callback tests independently cover actual app ownership guards and storage ordering. CI must execute the exact candidate browser and three platform packaged desktop/download jobs before claiming acceptance. Prior failed runs and local browser launch restrictions remain historical evidence, not erased by later success. No merge or deployment.
