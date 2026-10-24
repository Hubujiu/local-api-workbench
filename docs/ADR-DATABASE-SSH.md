# Explicit, ephemeral SSH transport for database operations

Reuse ssh2 1.17.0 (MIT), also identified in the original application's static database connection module. No original proprietary implementation is copied. This is a bounded PostgreSQL/MySQL transport implementation, not a claim that all original database providers or SSH options are compatible.

Each operation may supply an `ssh` object with host, optional port (default 22), username, exactly one of password/privateKey, optional private-key passphrase, and a required independently verified OpenSSH-style `hostKeySHA256` fingerprint. There is no trust-on-first-use, auto-accept, agent forwarding, shell, SFTP, retry, or direct-network fallback. Unknown options are rejected. Host identity is verified before authentication. Host fingerprints must come from a trusted source, not blindly from a failed connection.

The connection creates exactly one direct-tcpip channel to the requested database host/port. It does not expose a local listener or rewrite the logical database host to localhost. PostgreSQL receives the channel through its supported stream option with the minimal socket connection notification adapter; MySQL receives the same maintained Duplex transport. SQL parsing, bound parameters, result limits, read-only transactions and explicit PostgreSQL write permission remain unchanged. MySQL certificate identity verification is explicitly enabled in addition to certificate-chain verification. TLS over SSH currently requires a DNS database hostname; IP-only targets are rejected before opening SSH rather than silently changing certificate identity.

A maximum of five SSH operations can be live per process. Handshake timeout is three seconds and total channel lifetime eight seconds, separate from unchanged provider SQL timeouts. Failure/close releases the channel and SSH client; no SQL is replayed. PostgreSQL commit/rollback uncertainty retains its existing warnings. Unsupported providers reject SSH configuration rather than connect directly.

Session registrations may retain SSH credentials only in the in-memory project-scoped connection grant. Lists return id/name/type, not credentials. Revocation or restart invalidates the grant; saved requests/plans refer to its identifier. Project files and plan snapshots do not contain the password/private key. Database result values can still be sensitive and are governed by the normal result-sharing rules.

## Verification

Local tests use an actual ssh2 server: password and signed-key authentication, exact forwarding target, wrong host pin before authentication, invalid credentials, denied target, no fallback, connection limit/release, stalled handshake, and TLS-over-channel CA/hostname rejection. These transport tests do not substitute for database integration.

The existing database-integration job additionally uses real PostgreSQL/MySQL behind the fixture SSH server. It checks bound large-integer reads, query error cleanup, PostgreSQL key-authenticated write/duplicate rollback/readback, and project grant → database operation → pre-script → real HTTP → post-script assertion → persisted plan result. It also checks cross-project denial and absence of SSH credentials from project persistence. Claims about this complete flow require the exact commit's CI to pass.

Other providers, multi-hop/proxy transports, host-key rotation workflows and original native connection-data migration remain outside this implemented subset. The frontend is unchanged.
