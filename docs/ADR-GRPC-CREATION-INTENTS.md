# gRPC owner creation correlation after complete response loss

This extends retained-ID recovery, without treating it as remote delivery confirmation.
The owner UI first acquires a local creation intent for a saved definition. Acquisition
opens no gRPC channel. Before sending the one creation POST, it persists only the
instance/intent IDs, selected definition ID and uncertainty marker. If persistence
fails, creation is not sent. Temporary metadata, TLS keys and initial messages are
never placed in the journal or browser recovery storage.

Creation consumes an exact project/instance/definition-bound intent synchronously
before dispatch. The definition fingerprint also rejects edits after acquisition.
Consumed, expired, evicted or foreign IDs cannot start another stream, even if POST
is repeated with a different payload. Legacy API creation remains compatible;
new owner UI always uses correlation. MCP is unchanged.

Explicit read-only refresh uses the original project, instance and intent. Only a
created receipt with an exact matching session snapshot resolves unknown creation.
Reserved, expired, missing, restart, preflight-failed and unknown outcomes remain
blocked. In particular a read before a delayed POST does not cancel the POST or
claim it never happened. Unknown sends/half-close and persistence concerns are
not cleared. No automatic retry, stream recreation, initial-message resend or
remote-business success inference is introduced.

Memory is capped at 256 receipts, not 256 lifetime creations. Reserved entries
expire after five minutes; consumed entries are oldest-first eviction candidates.
Random server-issued IDs are never accepted unless still reserved in this instance.
Eviction sacrifices recovery availability, never re-enables an old operation.
Lost acquisition responses are safe because acquisition cannot create a stream.
Service restart intentionally destroys recovery evidence and rejects old IDs.

Evidence: manager ownership/definition/restart identity, duplicate payload refusal,
1000 creations with bounded retention, expiration, read-before-delayed-create, and
preflight failures; actual browser adapter persistence/GET route; real localhost
grpc-js bidi fixture with entire HTTP creation response discarded, ID-only reload,
exactly one stream and zero request messages. Cross-project recovery is refused.
This is not a claim to recover all gRPC or Socket.IO unknown operations.
