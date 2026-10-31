# Native OAuth2 token injection and inert definition storage

Work in progress. This is an opt-in backend model, not native grant-flow parity.
Existing OAuth2 token exchange and ordinary Bearer behavior remain unchanged.

## Static evidence and reuse

Lawfully obtained send-index.js SHA256
5dabd6d0b85214084895a7044f9b045bb005cb010ecec156e98cf883a914ceff:
Unicode offsets 9947302 (20 stored fields), 33609530 (native insertion),
336133xx (SDK Item), 262812xx (structured query precedence), 26225408
(duplicate keys), 279286xx/329270xx (legacy transport encoder).
The native branch reads access_token, not Postman's accessToken. Missing/empty
placement injects nothing; empty token injects nothing; empty header prefix
falls back to Bearer. Query insertion appends, preserving existing duplicate
access_token fields. It does not replace them via URLSearchParams.set.

Reuse the existing reviewed postman-collection URL-only subset and installed
postman-url-encoder 3.0.8 on one synthetic query pair. Never reparse the actual
URL through a legacy parser. No new dependency or original implementation copy.

## Model and boundaries

Opt in with auth={type:oauth2,nativeOAuth2:definition}; do not mix legacy token
or grant fields at auth's outer level. Keep all 17 known string fields and three
custom parameter arrays, including optional-field presence. Unknown top-level
fields and invalid/non-data descriptors reject. Metadata arrays are bounded
pure JSON, not a guessed executable schema: 256 items/array, depth 8, 2048 nodes,
64 KiB UTF-8 total definition. Reject cycles, holes, accessors, nonfinite/-0
numbers, special prototypes and prototype-sensitive keys. Never invoke toJSON.

Only literal header/queryParams/empty/absent placement is accepted. Templates
are permitted in token/prefix and inert metadata, not placement. Resolve only
selected token and, for a nonempty header token, prefix. Never evaluate grant,
state, endpoint, password or custom-array templates during ordinary sending.
Saved source definitions and frozen plans remain detached from wire preparation.

Runtime token/prefix must be well-formed text without controls, unresolved
markers or more than 8 KiB. Existing transport, TLS, cancellation and size guards
remain. Header validation errors are redacted. The selected mode alone mutates
its destination; empty/no-placement leaves caller headers/query unchanged.
cURL uses the same injection implementation; unresolved active templates reject.
OpenAPI rejects projects with native policy in active requests or shared auth
settings rather than emitting an unauthenticated definition; use full backup.
Full root integration must reject native policy with redirect until separately
validated; ordinary OAuth2 redirect support is unchanged.

Grant metadata is preserved, not executed or mapped to OAuthManager. No token
acquisition, automatic refresh, retries, consent, account access or original
runtime execution is introduced. Native format converters are a subsequent
change in existing PR14 after this runtime is verified. Do not call this complete
native OAuth2 authorization/refresh compatibility or whole-project completion.

## Acceptance

Pure model/descriptor/bounds/identity and exact independent encoding vectors;
actual header/query requests, duplicates, body integrity, error zero-I/O,
selected-template-only resolution, unchanged caller/source state, frozen plans,
backup/restore/reopen, owner SDK/CLI and cancellation. Verify exact feature/root
CI and actual packages. No previous head's tests substitute for this change.
