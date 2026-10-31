# Postman OAuth2 saved-token policy (bounded subset)

## Evidence and scope

Contract reviewed against official Postman Runtime **7.56.3**, commit
`994227833937323480ceda4682609ae3a5c41284`,
[`lib/authorizer/oauth2.js`](https://github.com/postmanlabs/postman-runtime/blob/994227833937323480ceda4682609ae3a5c41284/lib/authorizer/oauth2.js),
Git blob `e1286bca135da631886bdb9cc821378b222e898e`.
Runtime is Apache-2.0 (`LICENSE.md` blob
`e3ce0666964a84f73519dc69a1bbbd3211b63768`). This is an independently implemented
policy, not copied Runtime code or a claim of vendor-runtime execution parity.
Raw-key query removal follows reviewed Postman Collection SDK 5.3.1 commit
`01d914a2a132420f5db1695b34cea2668d645947` (`collection/url.js` and
`collection/query-param.js`). Injection uses the repository's existing reviewed
SDK host bundle and existing pinned `postman-url-encoder` 3.0.8 on **one synthetic
pair only**. The encoder is now a production dependency (unchanged version,
integrity, license); lockfile regenerated offline with scripts disabled.

Only four saved-token attributes are admitted: `accessToken`, `addTokenTo`,
`tokenType`, `headerPrefix`. No grants, acquisition, refresh, credentials,
redirect support, frontend editor, or full Postman collection-scope migration.
Acquisition attributes such as `clientId`, `clientSecret`, `authUrl`,
`accessTokenUrl`, and `scope` are explicitly rejected, not silently discarded.
Thus real collections containing those attributes require a reduced saved-token
export; full OAuth2 import parity is **not** claimed.

## Durable representation and semantics

`auth: { type: "oauth2", postmanOAuth2: { version: 1, ...fourFields } }`

This marker is distinct from ordinary `{type:"oauth2",token:...}` and from native
Apipost OAuth2, whose placement/prefix defaults differ. Mixed markers or legacy
outer token fields are rejected. Optional fields are absent or strings; explicit
undefined/null/non-string values are rejected. Empty strings remain empty after
backup and copying. Plain own enumerable data records only: no accessors,
custom prototypes, symbols, sparse attribute arrays or extra attributes.
Per-field bound is 8192 UTF-8 bytes; malformed Unicode/control characters reject.

- Missing/empty token: leave caller Authorization and query untouched.
- Missing/empty placement: header. Only `header` / `queryParams` are admitted.
- Missing/empty type: Bearer. Case-insensitive Bearer is admitted; MAC and other
  types reject. This intentionally avoids upstream's silent MAC no-op or fallback
  of every other unknown type to Bearer.
- Missing prefix: `Bearer`. Explicit empty/space-only prefix: bare token.
  Other prefixes are trimmed and followed by one space. Null is rejected rather
  than coerced. Controls (including tabs/newlines) are rejected rather than trimmed.
- A nonempty token removes the existing Authorization and **all literal raw**
  `access_token` query keys before selected injection. Encoded `%61ccess_token`
  and uppercase keys remain. New pair goes at the end. Unrelated raw escaping,
  plus signs, repeated keys, flags and empty separators remain unchanged.
- Existing duplicate Authorization singleton rejection is retained. Unlike
  upstream, ambiguous duplicate Authorization rows fail before replacement.
  Invalid/framing/control headers retain all existing checks.
- Query input is bounded to 1 MiB and 10,000 segments at injection.
- Only token and an active header prefix are interpolated. Query-mode and
  no-token prefixes stay inert. Placement/type cannot be templates. Unresolved
  selected templates and invalid post-resolution strings reject before transport.
- Duplicate auth attribute keys, unsupported row types, and `disabled:true`
  reject before project mutation. `disabled:false` is accepted. Disabled OAuth2
  attributes are not interpreted as absent.

## Interchange and safety

Execution and cURL use the same preparation helper. Direct unresolved cURL
selected fields reject; environment-aware export uses the existing resolver.
OpenAPI export rejects marked request/shared policies instead of dropping them.
Workbench backup/restore, normalization, frozen plan/case copies, shared auth,
and store write/read preserve and validate the marker. Input collection objects
are not mutated. Generic Bearer and ordinary OAuth2 behavior are unchanged.

The exact develop feature base has no native exporter or redirect-policy module.
Those integration-only routes must reject the Postman marker in the root
integration (rather than routing it through native OAuth2 or silently leaking a
query token to another origin). That guard is separately owned; this branch does
not claim those routes are covered. MCP/CLI/full collection-scope tests are also
root-integration work, not part of this feature's verified scope.

## Verification

`tests/postman-oauth2-model.test.mjs` is a pure data-only closure and covers
presence/empty distinction, malformed records, getters/prototypes, bounds,
source isolation and selected-field interpolation. It may run locally.
`tests/postman-oauth2-owner.test.mjs` is **CI-only**: actual independent HTTP/1.1
and HTTP/2 peers verify wire headers and exact raw query; tests exercise nested
inherited import, owner execution, frozen plans, results, backup/restore,
restart, project isolation, atomic negative imports, exporter guards and
cURL serialization/import roundtrip behavior (not external cURL binary execution). It is picked up by the existing `tests/*.test.mjs`
three-OS CI matrix. It must not be represented as locally executed.
No app, server, HTTP, VM or external vendor runtime was run locally.
