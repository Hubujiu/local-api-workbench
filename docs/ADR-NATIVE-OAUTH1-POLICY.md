# Canonical native OAuth1 policy definitions

Initial publication: contract only; converter and workflow acceptance pending.
Requires verified OAuth1 runtime PR73 at 27ed173c9614b261ca28f3033f1d9c93f54701af
and shared Digest fix PR20 at 9fd1d485695d8ca355a5ef713037b89dc040514d.
Pure dependency base 129a4a67fb58af3d7b65a3d003e8380fc5b1a4bc joins those with the
previous native-export dependency base, without root or PR14 feature ancestry.

## Evidence and scope

Legal original static send-index.js SHA256:
5dabd6d0b85214084895a7044f9b045bb005cb010ecec156e98cf883a914ceff.
Unicode character offsets: native mapping 33608834; OAuth1 handler
27885035–27893300; operational defaults 9946742–9947288. Native `token` is the
handler's OAuth access token, not a field already called accessToken. Four
stored switches control parameter placement, body hashing, inclusion of empty
OAuth fields and header encoding; they must not be dropped during migration.

This converts definitions for the bounded Workbench policy runtime. It is not
original raw-wire/body-builder equivalence, original weak nonce generation,
silent missing-secret auth skipping, whitespace-trim behavior, removal of
caller oauth_* fields, or additional signature-method support. Existing key,
timestamp, version, collision, raw-header, multipart and transport guards remain.
No original application, signer, key parser or network is invoked by conversion.

## Selected native section

Only these own enumerable data fields are accepted:
consumerKey, consumerSecret, token, tokenSecret, signatureMethod, realm, version,
nonce, timestamp, callback, verifier, privateKey, addEmptyParamsToSign,
includeBodyHash, addParamsToHeader, disableHeaderEncoding.
Plain/null-prototype objects only; reject symbols, hidden/accessor/undefined
fields and unknown aliases without invoking getters or toJSON.

- All four switch fields are REQUIRED literal booleans. Do not infer the
  constructor's defaults for sparse source objects or coerce numeric/string/
  templated switches; the handler and alternate stored defaults differ.
- consumerKey is a nonempty string. Signature method is explicitly one of
  HMAC-SHA1, HMAC-SHA256 or RSA-SHA1. Missing/empty/dynamic/other methods reject.
- Other credential fields are strings; omission canonicalizes to empty string.
  Version is empty or literal 1.0. Credential text/templates are preserved in
  the remaining fields, without interpolation or URL/key processing.
- privateKey is a recognized optional signing field, even though the operational
  default object omits it. It remains opaque text here; actual key validity and
  the existing inline-key restrictions are checked only at execution.
- Native passphrase, grant-flow endpoints or other unverified metadata fields
  reject instead of being discarded. Inactive outer auth sections are ignored;
  this is a selected-section contract, not a whole-envelope identity promise.

## Canonical Workbench representation and export

Use type=oauth1, consumerKey, consumerSecret, accessToken (from native token),
tokenSecret, signatureMethod, realm, version, nonce, timestamp, callback, verifier,
privateKey and privateKeyPassphrase="", plus the complete parameterPolicy:

- placement = addParamsToHeader ? header : auto;
- includeBodyHash = includeBodyHash;
- includeEmptyParams = addEmptyParamsToSign;
- headerEncoding = disableHeaderEncoding ? raw : percent.

Export requires explicit complete parameterPolicy and only the known canonical
fields. Missing ordinary text fields become empty; missing/empty Workbench
signatureMethod becomes explicit HMAC-SHA1, its existing runtime default.
Version remains empty or 1.0. A nonempty/templated privateKeyPassphrase cannot be
expressed by this native handler and rejects. Legacy policy-absent definitions,
extra ignored fields and unsupported controls reject; full Workbench backup is
available. Canonicalization does not promise original optional-field presence.

All canonical text must satisfy the shared OAuth1 model's data/UTF-8 checks.
Both selected native input and canonical native output are bounded to 64 KiB
UTF-8 JSON bytes after descriptor/type admission, including added defaults.
The canonical Workbench model's own 64 KiB bound also applies. Every accepted
import is exportable; export's reimport must deep-equal the canonical definition.
Errors use fixed field categories, never supplied field names, values or causes.

This validates definition shape, not credential correctness or successful
execution. Invalid keys, raw-header contents, timestamps or body-specific policy
combinations can still fail under the unchanged runtime guards. No evaluated
signature, generated nonce or amended wire query/body enters saved definitions.

## Whole-workflow acceptance

- Pure full flag/default/type/descriptor/unknown/method/version/template/size
  matrix, canonical inverse, immutability and redacted atomic errors.
- Native JSON and directory import/export/reimport with explicit imported
  environment selection; independently verified actual HMAC/RSA signatures,
  body hashes and header/query/form placement, including repeated parameters.
- Frozen/live edits, backup/restore/reopen, official SDK canonical/native aliases,
  CLI, source/foreign-project isolation, cancellation and invalid zero-I/O paths.
- Root separately validates project/folder/own/noauth inheritance and explicit
  flattening, frozen restored plans, and unchanged OpenAPI unsupported-auth guard.
- Actual feature/root CI and current three-platform portable bytes are required.
  Prior runtime/dependency green results are not converter acceptance. No new
  dependency, signer, frontend, security or timing-budget change is included.
