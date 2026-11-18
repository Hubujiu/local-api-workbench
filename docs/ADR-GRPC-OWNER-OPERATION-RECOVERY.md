# Correlated owner gRPC send and half-close recovery

Owner GET session snapshots now carry a process-instance ID, per-session monotonic
sequence and bounded operation receipts. The new UI requires a read-only refresh
before its first outbound operation. It persists a sequence plus random nonce,
operation kind, instance and session ID before dispatching exactly one mutation.
No message, metadata, TLS material or receipt payload enters browser recovery storage.

The server verifies owner project/session, instance and exact next sequence before
calling the existing trusted transport observers. A consumed sequence, even with
a different nonce, is never reaccepted. Duplicate POSTs are rejected, not replayed.
Receipts distinguish pending, locally-written, half-closed, failed-before-submit,
and unknown. Callback/drain completion is local transport evidence, not remote
business success. Existing terminal observer settlement freezes unknown outcomes;
a later callback cannot upgrade them.

Explicit GET reconciles only the persisted operation's exact identity and kind.
Only local completion or definite pre-submission refusal can remove that operation's
UI uncertainty. Any unknown/failed request message still keeps the guard. Pending,
missing, mismatched, evicted and restarted-instance evidence never unlocks it.
Storage failures restore uncertainty. Creation, terminal-record persistence and
outbound operation uncertainty remain separate. There is no automatic retransmit.

Each existing manager-owned session has at most 128 receipts, held in a WeakMap.
Only settled details are evicted; a monotonic watermark still rejects retired IDs.
Preflight failures consume sequence numbers but cannot impose a lifetime cap;
1000 attempted operations are covered. Sessions retain their existing 100-message
and byte/time limits. MCP and legacy uncorrelated owner calls remain unchanged;
legacy unknown UI markers cannot be cleared by unrelated new receipts.

Evidence includes real local grpc-js bidi transport: discard entire send and
half-close HTTP responses, restore ID-only state, read correlated outcomes, reject
duplicate send, verify one stream and exactly one remote fixture message. Unit/UI
coverage includes wrong instance/project/nonce/kind, pending and unknown callbacks,
late completion after unknown, preflight failures, bounded retention, independent
transport failures and failed recovery persistence. No remote exactly-once claim.

The shared project execution/reload guard is intentionally not cleared by a session
receipt. If an HTTP error also raised that guard, the existing explicit project
reload is still required before another mutation; this patch does not acknowledge
unrelated project-save/import uncertainty on the user's behalf.
