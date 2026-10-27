# OAuth1 owned loopback callback (draft)

## Contract and source

RFC 5849 §§2.1–2.3 defines the signed callback URI, confirmed temporary
credentials, returned temporary-token/verifier pair, and one-time token
exchange: https://www.rfc-editor.org/rfc/rfc5849#section-2.2 . This implementation
uses the existing reviewed OAuth1 signer and HTTP executor. No dependency,
provider account, browser automation, frontend or authorization grant is added.

Existing `POST /api/oauth1/start` defaults to OOB/PIN, unchanged. Explicit
`callbackMode: "loopback"` opts into an owned callback. Other values, including
null/empty/booleans, reject before provider I/O. The server builds the callback
from its actual loopback listener (`http://127.0.0.1:<port>`), never the inbound
Host or a caller-supplied redirect URL. Each start creates separate random
192-bit flow and callback-path capabilities. Only the callback path goes to the
provider; the flow ID is not the callback token.

The request-token POST signs the owned callback URI. A confirmed temporary token
and secret remain in memory. The browser/provider redirect uses exactly one
`oauth_token` and `oauth_verifier` on that random callback path. Unknown fields,
duplicates, malformed escaping, missing/invalid verifier and wrong tokens reject
without consuming a legitimate pending flow or issuing a token POST. A valid
callback claims its flow synchronously, then signs the existing token exchange.
Concurrent/replayed callbacks cannot issue another POST. Success/failure removes
temporary credentials and callback capability; errors expose only fixed text.

## Backend API and ownership

All management routes retain existing local-token and Host/Origin checks:

- `POST /api/oauth1/start`: existing configuration plus optional callbackMode;
  loopback response adds redirectUri to id/authorizationUrl/expiresAt.
- `GET /api/oauth1/status/:id`: status/expiresAt and a fixed error if failed;
  never returns credentials, verifier, provider text or authorization headers.
- `POST /api/oauth1/complete`: loopback `{id}` retrieves accessToken/tokenSecret
  once, deleting the flow. A verifier here is rejected. OOB `{id, verifier}`
  continues to exchange and return tokens directly as before.
- `POST /api/oauth1/cancel`: `{id}` aborts and removes exactly that owned flow.

Only `GET /oauth1/callback/<random-path>` accepts a provider redirect without the
local token. It retains Host/Origin checks and rejects foreign absolute request
targets/fragments. Its fixed plain-text success/error response never echoes
parameters, secrets or local token; no-store, no-referrer, nosniff and a restrictive
CSP are set. This endpoint does not offer a generic proxy or return credentials.

The app is single-user with a local management capability. Flow IDs isolate
simultaneous operations; this is not a new multiuser or project authorization
model. The API does not implicitly bind to whichever project the UI happens to
show. It never writes project settings, history, cookies or credentials. An
owner must explicitly save returned credentials through existing project APIs.

## Lifetime and cancellation

Existing limits remain: ten flows, five-minute lifetime, 15-second total network
exchange deadline, HTTPS except literal loopback endpoints, verified TLS, no
redirect follow or automatic retry, existing bounded token response/output.
Completed results count toward flow capacity until consumed, cancelled or expired.

Every flow owns an AbortController and expiry timer. Incoming start/OOB-complete
or callback response disconnection cancels the corresponding active provider
request. A successful already-finished callback is retained for owner retrieval;
normal response closure does not cancel it. Shutdown closes ownership when
server.close begins, rather than waiting for active responses to finish. Expiry,
explicit cancellation and shutdown remove state, abort actual provider sockets,
and reject late completions. Restart cannot recover flow IDs or verifier state.
Cancellation discards local results; it cannot prove the provider did not issue
remote credentials, revoke those credentials or undo remote effects.

## Validation checkpoint and boundaries

Local 22/22 OAuth1 tests pass, including 14 new real loopback provider/API flows:
independent HMAC verification, protected-resource use, one-time result retrieval,
no data-file changes, malformed callback fields/replay, real Host and Origin
checks, concurrent flows/projects, confirmed-response errors, request/callback
socket cancellation, expiry during exchange, shutdown/restart invalidity, capacity,
and the actual unchanged 15-second timeout. Existing OOB/PIN and signer fixtures
remain passing. Provider fixtures are fictional; no real account is authorized.
Platform CI and broader regressions remain pending. This is a backend-only draft,
not full vendor parity, a new UI, or permission to merge/deploy. Some providers
require registered fixed callback URLs or add nonstandard callback fields; those
are not silently accepted by this narrow per-flow loopback contract.

### Resolved-promise cancellation boundary

Review found that checking ownership only inside an inner exchange promise leaves
an additional completion continuation before publishing the outer result. The
final implementation rechecks flow identity, expiry, closed state and caller
cancellation immediately after each public start/callback/OOB-complete await.
A deterministic fixture still performs the real signed local-provider exchange,
then delivers cancellation at the resolved inner-promise boundary. The initial
stage failed with a missing expected rejection; the correction rejects both
callback and OOB results and leaves no flow to resurrect. This is a test-owned
scheduling seam, not a claim about arbitrary real-provider timing or revocation.
