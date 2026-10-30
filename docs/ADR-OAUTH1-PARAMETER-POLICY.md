# Explicit OAuth1 parameter placement and body-hash policy

Initial publication: design/acceptance contract only, not implemented or accepted.
Base: develop 88f70bb515c48b93536b28b7fe3ec780f2e150f3. This is a separate runtime
feature; native import/export will integrate it separately after verification.

## Source-backed gap and dependency decision

Legal original static send-index.js SHA256:
5dabd6d0b85214084895a7044f9b045bb005cb010ecec156e98cf883a914ceff.
Unicode character offsets 27885035–27893300 establish native OAuth1 parameter
placement; 27879276–27881200 defines optional body hashing; 9946742 gives stored
defaults. Native defaults place OAuth parameters in PUT/POST URL-encoded bodies,
otherwise query, and hash supported non-form bodies. Current Workbench is header
only. Merely renaming native token to accessToken would not preserve those choices.

Reuse only node-oauth1 1.3.0's normalizeParameters on fresh scalar string pairs.
Public audited source: postmanlabs/node-oauth1 commit
7b1b30a0c685bbc0ef7ce4d9a0318eecd285831c, index.js blob
73f6dfe1e81e43d30a360f995826bc471d0d1db9; Apache-2.0, Netflix 2008 attribution,
zero runtime package dependencies. Official postman-runtime lock at commit
994227833937323480ceda4682609ae3a5c41284 (blob
54dd4f7f6c4f627f509836f08f61ef282bdeaf7a) pins its npm URL/SHA512 integrity.
The npm artifact itself must be integrity-checked by install/CI, not assumed
identical from metadata alone. Include the full Apache license and attribution.

Do not use the dependency's Math.random nonce, timestamp/global registry,
regex URL parser, raw key signer, header trimming or arbitrary-object helpers.
Fresh validated pair arrays avoid its inherited-key/array-value hazards. Keep
our cryptographic randomBytes nonce, WHATWG URL/Host handling, existing method
allowlist, explicit bounded inline RSA key parsing and Node crypto signatures.
A master package claiming scoped version 1.4.0 has no verified tag/release;
it is not selected. No proprietary original handler is copied or run.

## Static model and legacy behavior

Auth may add a complete, static `parameterPolicy` with exactly:

- placement: `header` or `auto`;
- includeBodyHash: boolean;
- includeEmptyParams: boolean;
- headerEncoding: `percent` or `raw`.

Absence preserves existing OAuth1 behavior. Present null/undefined, partial or
unknown keys, templates, coercions, inherited/hidden/accessor fields and policy
on other auth types reject before cloning/interpolation/scripts/network. The
browser-safe validator validates exact own-data descriptors and returns a fresh
immutable policy. Shared scopes permit this sole typed nested exception only
after the normal auth validator; other nested data and existing limits stay closed.
Snapshots/save/import/restore and direct/raw-plan entrypoints retain the model.

Policy execution uses existing HMAC-SHA1, HMAC-SHA256 and RSA-SHA1 only. No
PLAINTEXT, SHA512, accessor aliases or new key/algorithm modes are enabled.
Existing timestamp/version/consumer-key requirements and 10,000 ordinary-pair
limit remain. Old policy-absent requests keep their wire behavior and validation.
Lifecycle/token-exchange manager options remain unchanged and do not implicitly
acquire this policy from shared configuration.

## Request semantics

Sign decoded ordinary query/form pairs exactly once, preserving duplicates and
empty ordinary values. Keep the existing rejection of any caller-supplied
`oauth_*` query/form field; do not silently remove/replace it as the original does.
Base URI retains existing WHATWG/Host semantics and excludes query/fragment.
The public dependency supplies only deterministic encoded name/value sorting.

With includeEmptyParams, include empty oauth_token and oauth_version in the
signed/emitted core parameter set; otherwise omit their empty values. Nonempty
callback/verifier are still included, not invented when empty. Nonce and timestamp
remain generated safely when absent. Realm is header-only and never signed.

Header placement keeps ordinary body bytes unchanged. Percent mode uses the
existing escaping. Raw mode accepts only unambiguous visible ASCII values,
rejecting quotes, backslashes, controls and edge whitespace before I/O. Policy
header values with edge whitespace also reject rather than reproduce original
trim/sign disagreement. Header + included empty core fields rejects when that
would reproduce the original signed-but-unemitted ambiguity. Legacy headers
without a policy are unchanged.

Automatic placement appends OAuth parameters to the actual URL-encoded body
only for PUT/POST with bodyType=urlencoded; otherwise to query. Keep ordinary
query/body bytes and repeated fields, append newly encoded protocol pairs in
RFC3986 form and overwrite/remove competing Authorization consistently. Recompute
Content-Length after body append. Recheck the existing 8 MiB body cap after any
append; retain redirect URL/header limits and the single total deadline.

For includeBodyHash on non-form requests, hash actual finalized wire bytes
(including empty bytes) using SHA1 for HMAC/RSA-SHA1 or SHA256 for HMAC-SHA256.
Base64 oauth_body_hash is both signed and emitted. URL-encoded bodies are never
hashed; nonempty multipart + requested hash rejects rather than guess vendor
body-builder behavior. Raw/JSON/binary hashing is over Workbench bytes, not an
assertion of original body-builder or disabled-URL-encoding wire equivalence.

No generated nonce, signature, query parameters or amended body is written back
into saved definitions/frozen snapshots. A fresh execution signs again. No retry,
credential lookup, external token flow, cross-origin authority expansion or
application/test/job budget change is introduced.

## Complete acceptance gates

- Pure policy full type/descriptor/default matrix; malformed static settings
  cannot become valid after variable interpolation or script mutation.
- Public normalizer equivalence to independent RFC5849 vectors and pre-existing
  legacy cases: duplicates, empty names/values, Unicode, percent/plus, Host/IPv6,
  no mutation/global registry changes. Dependency install integrity and audits.
- Independent HMAC/RSA verification of actual header/query/form output and body
  hash, all supported methods, empty/raw/JSON/binary/form bodies, repeated pairs,
  include/omit-empty settings, raw-header safety, key limits and collision refusal.
- Whole owner save/freeze/live-edit/restore/restart, two official SDK aliases,
  CLI, foreign grant isolation, cancellation/no later step and zero-I/O invalid
  routes. No direct signer-as-oracle proof.
- Root-only shared/native inheritance, nested plans and redirect interactions
  receive separate actual integration gates; source guards stay strict.
- Ordinary feature/root exact-head full CI and fresh three-platform portable
  bytes establish acceptance. Static review or prior green runs do not.
