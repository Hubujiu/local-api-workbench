# OAuth2 token exchange ownership and credential placement

## Decision

Keep the existing authorization-code + PKCE S256, client-credentials and refresh-token grants. Reuse the shared HTTP executor, its TLS verification, no-redirect behavior and request/response limits; do not modify general HTTP Basic or add a dependency, grant, MCP tool, automatic refresh or retry.

- RFC 6749 [§2.3.1](https://www.rfc-editor.org/rfc/rfc6749#section-2.3.1) requires individually form-encoding the client ID and secret before constructing OAuth2 Basic credentials. Preserve whitespace, reserved characters and Unicode; reject malformed Unicode instead of substituting credentials. `basic` sends only the authorization header, `body` sends client fields in the form, and `none` sends the client ID but never a stale secret. An omitted or empty-string mode retains the existing body default; null, booleans, numbers and unknown modes are rejected before I/O. Authorization codes and refresh tokens likewise reject malformed Unicode rather than silently changing credentials. Extra grant fields cannot override credential placement.
- Credentials are sent only to the configured token endpoint. The executor does not follow redirects or automatically retry a failed/uncertain POST. No token-exchange request, response, token or credential is automatically saved into project state/history, cookies or logs. Provider error descriptions are not echoed, since providers may include credentials; only recognized OAuth error codes and HTTP status are surfaced.
- Keep the 15-second exchange deadline, five-minute flow lifetime and ten-flow limit. Direct exchanges also have ten active slots. Tokens must have bounded, correctly typed fields in a JSON object (64 KiB response, 8 KiB text fields); a missing token type retains the previous Bearer default. Unknown response extensions are ignored. Explicit token types must be Bearer (case-insensitive); MAC, DPoP and other schemes fail with a fixed error rather than returning false acquisition success and later mis-sending them as Bearer. This follows [RFC 6749 §7.1](https://www.rfc-editor.org/rfc/rfc6749#section-7.1): do not use a token type the client does not understand. No new token scheme or frontend behavior is introduced. The shared HTTP 8 MiB transport ceiling is unchanged.
- Every exchange owns an abort controller. The exported standalone exchange accepts caller cancellation; app exchanges are additionally owned by the manager. Incoming token/callback response disconnects cancel only their exchange, with listeners removed on settlement. `server.close()` closes OAuth ownership at shutdown initiation, not at the later close event that waits for active responses.
- A callback synchronously claims its state before awaiting. Invalid/provider-error/cancelled/failed exchanges consume state; replay/concurrent completion cannot send a second POST. PKCE verifier and state are erased after completion; config is erased on both success and failure. Successful results remain available for existing status polling until expiry. Expiration and manager close abort I/O and erase all flow secrets/results. Closed managers cannot start new operations.
- Verify the exact live flow, closed flag, cancellation and expiry before/after asynchronous exchange work; never publish a late token. Cancellation, timeout, expiry and shutdown are distinct failures. Cancellation discards local results and closes owned sockets; it does **not** guarantee the provider has not issued a token and does not revoke a remote token.

## Evidence and scope

`tests/oauth-lifecycle.test.mjs` uses fictional credentials and real loopback sockets: strict independently encoded Basic/body/none providers, all supported grants through owner HTTP, PKCE hash/redirect verification, explicit bearer use, no project mutation, ordinary Basic regression, pre-abort/no I/O, callback replay, in-flight cancellation/expiry/shutdown, actual peer socket closure, unrelated-flow isolation with out-of-order completion, ten-flow/exchange slot limits, owner token/callback disconnect, invalid/oversized responses, redirect/no-leak and failure/no-automatic-retry. A real 15-second held POST distinguishes timeout from cancellation. An explicit owner save/export/restore/restart test then proves the saved bearer works without automatic reacquisition, while another project remains unchanged. Existing OAuth2, OAuth1, HTTP/runtime and server tests are targeted regression coverage; not a full-suite or real-provider compatibility claim.

No frontend, real accounts, authorization popup, original client/EULA interaction, deployment or main/develop merge is part of this change. Tokens remain unsaved until the owner explicitly saves a request using the existing project workflow.

## Strict callback form encoding

The owner callback validates raw query percent encoding and UTF-8 before
`URLSearchParams` can repair invalid bytes. For example, `%FF` must not become
U+FFFD and be sent as a different authorization code. Malformed parameter names
and extension values are rejected as malformed form input as well; valid unknown
extensions are still ignored. This parsing check runs before the existing duplicate
field guard and before the manager claims a state. Parsing/duplicate failures leave
a pending flow usable; validly decoded missing codes, control characters and
provider errors retain the existing state-consuming failure behavior.

Valid UTF-8, including explicitly encoded U+FFFD, is accepted. Form `+` remains a
space, `%2B` remains a literal plus and `%25FF` remains the literal text `%FF`.
No token fields, transport limits, grants, retries, caller ownership or persistence
rules change. `tests/oauth2-callback-encoding.test.mjs` uses raw HTTP callback
request targets and an actual loopback token server to verify wire fidelity,
PKCE, no POST/no project mutation on rejected syntax, replay and compatible
semantic-error handling. The pre-fix raw `%FF` callback actually returned 200 and
posted `code=%EF%BF%BD`; that RED evidence is retained separately. The normal
lifecycle and saved-token restore/restart workflow files remain regression gates.
