# Postman OAuth1 literal import subset

Status: implementation in progress; owner/wire acceptance requires CI. Fixed dependency: PR73 at 27ed173c9614b261ca28f3033f1d9c93f54701af. This PR changes conversion, not the signing engine or native automation adapter.

## Evidence

Official Apache-2.0 postman-runtime 994227833937323480ceda4682609ae3a5c41284, `lib/authorizer/oauth1.js` (blob fe39c3030a4dd5851d64b011bc28481f9debc47c; SHA256 def137e343a548c21ac19fc6ae55d9877cccd02b95c0350d03d101f564b56437) reads `token` and four switches. `addParamsToHeader` selects header versus auto form/query; the other switches control body hash, empty signature fields and raw header encoding. All omitted switches are false. This differs from the pre-existing Workbench canonical header default.

Matching SDK postman-collection 5.3.1 at e2453a5c1eb23f92f09df68712b30a87f775bb6d, `lib/collection/variable.js`, casts with String/Boolean. Text "false" is not boolean false. `auth-interface.js` selects PropertyList.one, not normalized environment-variable filtering. The runtime calculates body-hash eligibility before the node-oauth1 missing-method fallback, so an importer must not claim blindly filling HMAC-SHA1 preserves all missing-method behavior.

## Contract

Only selected OAuth1 auth arrays are converted. Existing collection/folder/request inheritance remains; explicit noauth still stops source inheritance. Official token maps to canonical accessToken. Complete parameterPolicy is always materialized: auto, false, false, percent unless explicit boolean switches override. Existing native canonical OAuth1 without policy is unchanged.

Accept literal strings with absent/string/any type and boolean switches with absent/boolean/any type. Require explicit HMAC-SHA1, HMAC-SHA256 or RSA-SHA1 and complete consumerKey plus consumerSecret/privateKey. The official runtime may skip signing incomplete inputs; we reject rather than silently sign a different request. Reject templates, nonempty whitespace-only strings, unknown fields/record metadata, duplicates, unsupported types and both token/accessToken aliases together. Legacy Workbench accessToken and privateKeyPassphrase are retained only as explicitly documented compatibility extensions, not official Postman properties. No credential values appear in conversion errors. No acquisition, script evaluation, interpolation, coercion or I/O occurs during conversion.

Inputs are capped at 32 dense attributes and 64KiB combined string values. Direct helper Proxy/accessor inputs are rejected without calling hooks. This is not a claim that the entire document importer accepts arbitrary hostile JavaScript objects; ordinary interchange is JSON.

Literal-only is deliberate: resolved templates can become empty or whitespace-only and trigger different upstream skip/filter behavior. Supporting dynamic credentials requires a separate proven runtime contract; this change does not claim general Postman parity. Existing canonical signer restrictions (OAuth parameter collisions, unsafe raw headers, unsupported multipart hashes, empty header requirements, algorithms) remain fail-closed rather than silently approximated. cURL retains its existing OAuth1 refusal. OpenAPI now explicitly rejects OAuth1 with parameterPolicy rather than silently losing signing semantics. Native format export is not present on this isolated dependency base and must be checked separately during root integration; project backup/freeze retains the canonical policy.

## Validation

Three dependency-free RED assertions actually failed against the extracted original converter: token and omitted/explicit switches. Pure conversion tests then verify mapping, defaults, supported types, bounds, malformed inputs and no secret/hook leakage. Owner contracts cover real import/freeze/signature peer/scripts/history/backup/restart/isolation. Local owner executions remain **0** because node-oauth1 is unavailable; no dependency bypass was attempted. Normal CI must establish actual runtime outcomes on the exact feature tree before acceptance.

OpenAPI 3.0.3 [Security Scheme Object](https://spec.openapis.org/oas/v3.0.3.html#security-scheme-object) can describe an HTTP scheme name, but has no standard fields for these signing execution policies. [Swagger 2.0](https://spec.openapis.org/oas/v2.0.html#security-scheme-object) admits basic/apiKey/oauth2. This is not a claim that OAuth1 cannot be documented at all. The pre-existing no-policy OAuth1 export omission is outside this patch; the new refusal is limited to explicit parameterPolicy. The old import fixture now declares HMAC-SHA1 explicitly; missing-method source inputs are intentionally rejected rather than silently applying a non-equivalent fallback.

The scoped OpenAPI guard resolves effective request/global/folder auth only when an OAuth1 policy candidate exists; explicit overriding credentials and inheritAuth:false retain their behavior. The converter does not implement outer collection/item protocolProfileBehavior, including disableUrlEncoding; equivalence is limited to the accepted auth fields under the existing Workbench request model, not an assertion that every surrounding Postman request option is preserved.
