# Digest auth-int entity replay

The existing challenge path signed the first serialized request entity, then recursively rebuilt the authenticated request. Multipart serialization generates a fresh boundary, so the Authorization value did not match the bytes actually sent. An independently authored loopback SHA-256 verifier reproduced JSON success and multipart failure.

The retry now receives module-private prepared entity state: the exact body bytes, generated Content-Type and original absolute network/authentication deadline. Serialized request definitions cannot supply this state. A separate connection is still prepared for the authenticated attempt, preserving Connection: close, proxy headers and TLS behavior. Cookie handling remains per session. Both connection preparation and request I/O use the remaining original budget, rather than allowing normalization's minimum timeout to extend the second round.

There is still at most one retry, only for an explicit supported Digest 401 challenge. A failed authenticated response, timeout, abort or uncertain network outcome never starts a third request. Request size limits and TLS verification remain in place. New user executions serialize independently; no prepared retry state is added to saved request/plan definitions. Existing execution wire evidence intentionally retains transmitted headers/body display.

Tests verify actual received bytes independently for multipart text/files/empty forms, raw, JSON, MessagePack, binary and URL-encoded data; concurrent identities, bad passwords, cookies, cancellation/deadline exhaustion and an HTTP proxy. Actual application plan execution, disk persistence, restore and server restart are exercised. This is standards-based Workbench evidence, not a new original Apipost runtime comparison.

Reference: RFC 7616 section 3.4.3 specifies the entity-body hash for auth-int: https://www.rfc-editor.org/rfc/rfc7616.html#section-3.4.3 . Implementation and fixtures are independently authored; no proprietary source is copied.
