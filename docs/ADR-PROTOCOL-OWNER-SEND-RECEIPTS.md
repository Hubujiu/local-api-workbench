# Owner protocol send receipts

The owner TCP/WebSocket session UI now persists a per-send operation ID (intent UUID, monotonic sequence, random nonce)
before submitting a message. Its authenticated send includes the instance ID,
connection intent ID, session ID and operation ID. The instance's intent ledger
retains only their correlation, a message digest, an event ID and local outcome.
The legacy owner API remains available for callers that do not opt into this
receipt contract; it must not be advertised as offering correlation guarantees.

A bounded ledger (256 retained receipts across all owner intents)
records `pending`, `locally-written`, `failed-before-submit`, or `unknown`.
Reusing an operation with the same message returns its current receipt without
sending again. Changing its message conflicts. A per-intent high-water mark prevents an old sequence from ever being accepted
again, even when its detailed receipt has been retired. Completed receipts can
be evicted to admit new sends, so there is no 256-send lifetime limit. Pending
receipts remain pinned; only 256 simultaneous unresolved sends apply backpressure.
A retired or previously used sequence returns 410, and sequence gaps return 409.
Reading a retired receipt cannot recover remote business outcome, and never
triggers replay. A nonce prevents two tabs choosing the same sequence from
mistaking each other's receipt for their own. Watermarks live in the already
bounded intent entries. Reads and stop operations remain available. Receipts never authorize
access: owner authentication, instance/session/intent matching and project-session
isolation remain required. Request secrets and raw payloads are not added to
recovery storage or the receipt ledger. Existing session evidence still contains
payloads and must be handled as sensitive output.

After a lost send response, the refresh button or restore reads the existing
intent. Only the matching operation's conclusive local outcome releases the send
lock. `locally-written` proves only the local write callback completed, not remote
receipt or business success. The previous remote-unknown warning remains.
`failed-before-submit` proves no transport submission occurred and permits a new
explicit send, never automatic retry. Missing, mismatched, malformed, pending or
unknown receipts do not unlock an active connection. A terminal snapshot can
still unlock the connection lifecycle without resolving remote delivery.

Transport termination freezes pending outcomes as unknown; late write callbacks
cannot promote them. Instance restart and session expiry do not prove remote
outcomes or make a previously submitted mutation safe to replay. This contract
does not extend to project sessions, gRPC, Socket.IO, or MCP operation ledgers.

Tests cover real HTTP response loss plus TCP byte-count/reload reconciliation,
receipt corruption and operation mismatch, 1,000 manager sends and 301 real HTTP/TCP
controller sends beyond the retained window, pinned-pending backpressure, retired-ID
rejection, nonce collisions, unsafe sequences, payload conflict,
pre-submit failure, stale instance/project isolation and terminal callback races.
