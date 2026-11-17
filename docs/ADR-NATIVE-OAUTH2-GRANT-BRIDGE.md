# Explicit native OAuth2 owner bridge (work in progress)

This feature extends PR74 using the independently reviewed PR31 secure OAuth
lifecycle as a fixed dependency. The dependency snapshot is separate from the
backend integration branch; existing state, S256, callback, token validation,
provider-error sanitization, concurrency, expiry and cancellation rules remain.
No frontend development, provider deployment or original application execution.

## Deliberate activation

Normal native import, API send, scripts, Mock, plans, MCP request execution and
backup continue to treat grant metadata as inert. Only explicit authenticated
owner POST `/api/oauth/native/start` with `{auth}` or
`/api/oauth/native/refresh` with `{auth,refreshToken}` invokes this bridge.
The auth object uses the existing `{type:"oauth2",nativeOAuth2:definition}` codec.
Unknown top-level fields, non-data properties and invalid native definitions
reject before any provider request. No project, source definition, frozen plan,
refresh-token cache or persisted credential is implicitly changed.

Start accepts only native `authorization_code` or `authorization_code_with_pkce`.
Both deliberately use our managed S256 flow, not the original weaker popup flow.
`client_authentication` must explicitly be `header` (maps to Basic) or `body`.
`authUrl`, `accessTokenUrl`, `clientId`, optional `clientSecret` and `scope` map to
canonical OAuthManager configuration; only literal resolved bounded fields are
accepted. Password, client-credentials, implicit or unknown grants do not fall
back to another grant. The original UI's password grant is not implemented here.

Nonempty `redirect_uri`, `state` and `code_verifier` are rejected for start; caller
metadata cannot select the callback or replace fresh single-use state/verifier.
`challengeAlgorithm` must be absent, empty or S256. All three custom parameter
arrays must be empty or absent. Control characters, unresolved templates,
userinfo/fragments/non-HTTP endpoints and selected fields above 8192 UTF-8 bytes
reject. Client ID and selected endpoints must be nonempty. This is a restricted
managed flow, not a claim that every imported native authorization definition
runs unchanged.

Refresh requires a separate explicitly supplied opaque refreshToken (nonempty,
no controls, <=8192 UTF-8 bytes), and an explicit literal refreshTokenUrl. There
is no fallback endpoint, cache lookup, auto-refresh, implicit retry or persistence.
Its callback/state/verifier and unrelated source fields remain inactive; the
standard refresh_token grant is constructed by the backend. Opaque token braces
are sent literally, not interpreted as templates. A returned access/refresh token
belongs to this owner invocation. Applying an access token to a project must use
an existing explicit owner save; refresh tokens are not added to native metadata.

## Evidence and intentional differences

Legally obtained Offline2 2.0.0 package SHA256
`7c66b8963960dd22a384072ecb714c9d8ba1164bb2ecd8f2d90d325fa3d83942`.
Only plaintext data inspected. Renderer chunk `9108.9075c9800ffe.js` SHA256
`6ce5ed1b3b0aaf8b4f7adf5ad4bc0ea814bc91618ed8d27aa55a97e3ff4656ff`:
UTF-8 byte ranges [15380,17121) build token exchange, [21084,23390) initiate code
flow, [24642,26893) refresh, [26893,28580) gate the visible buttons. Main renderer
SHA256 `20bb6e21fd678ead16bd91807dc9623b8cd3e7019d44ac874a167c31a37f39fb`,
[3768937,3771200) contains the proxy/fetch bridge; its backend handler has not been
proven. [3641898,3642600) shows refresh cache separate from the 20 native fields,
keyed by uid/clientId rather than project. We do not import or reproduce it.

Observed original client-auth selection and refresh/state handling are
inconsistent. The adapter follows declared field roles and the reviewed secure
OAuthManager, not proprietary implementation or unsafe wire quirks. No original
source, binary, account secret or paid-feature bypass is included.

Acceptance requires real local provider HTTP for Basic/body code exchange,
S256/state validation and one-time consumption, cross-owner isolation, explicit
refresh, malformed/error/cancel/close paths, zero provider I/O on preflight
refusal, original definition immutability, explicit token application followed by
real API execution, freezing and backup/restart. Syntax checks are not acceptance.
