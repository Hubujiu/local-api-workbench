# ASAP authentication

ASAP is a local signing mode, not a service-registration or key-discovery client.
The protocol reference is https://s2sauth.bitbucket.io/spec/ . Its asymmetric-only
rule takes precedence over a symmetric default found in a public source UI.

## Explicit contract

- RS256 is the default. RS/PS/ES 256, 384 and 512 reuse the JWT signer's bounded
  key validation. HMAC and `none` are rejected; keys are unencrypted inline PEM.
- `iss`, `aud` and `kid` are required. Key ID must begin with `iss/`; identifiers
  reject empty, dot and parent path segments. Audience accepts one string or a
  JSON array of at most ten strings.
- `ttlSeconds` defaults to 60 and accepts integers from 1 through 3600. Each
  execution creates current `iat`, derived `exp` and a fresh UUID `jti`.
- Optional `sub` is separate from the bounded JSON-object `claims`. Claims cannot
  override dedicated fields. Optional `nbf` must not exceed expiration.
- Transport is always Authorization Bearer, never query or body. No remote key
  discovery, public-key upload, account login or service registration occurs.
- Project saves retain credentials in plaintext like other explicit auth modes.
  Use fictional test keys and do not commit real keys. Prefer HTTPS.

## Interoperability boundary

This is a request signer; the recipient must already trust the issuer/public key.
It does not provide server verification, replay storage or clock synchronization.
OpenAPI exports a Bearer security scheme without credentials. cURL export refuses
rather than emitting a stale signed token. Postman ASAP import remains unsupported.
The native Apipost adapter now has a bounded canonical definition contract in
[ADR-NATIVE-ASAP-CANONICAL-ROUNDTRIP.md](ADR-NATIVE-ASAP-CANONICAL-ROUNDTRIP.md):
static original evidence establishes native `exp` as a duration, and conversion
uses explicit `ttlSeconds`. Adapter implementation is pending ordinary CI
acceptance; it is not original execution or wire-equivalence validation. The
runtime still rejects an explicit legacy `exp` rather than guessing a lifetime.
Native conversion rejects unsupported definitions (including legacy PEM key
envelopes) without changing ordinary signer support; full project backups retain
those definitions unchanged.
