# Explicit Digest challenge policy

Status: approved contract; implementation and runtime acceptance pending.
Feature base: PR 20 exact `3bbbbdd0d9b8a550ddd32458bdf3a6febc7d0dbf`.

## Scope

Add an optional explicit Workbench Digest challenge policy, without activating
previously ignored top-level fields or changing legacy challenge negotiation.
This is the runtime prerequisite for a separately delivered native credential /
challenge-bootstrap adapter. Native conversion belongs to PR 14 after a narrow
join with the completed PR 20 head, not this change. No broad root dependency,
original execution, license acceptance, preemptive signing, authentication state
cache, 403 retry, stale retry, proxy authentication or extra request is added.

## Definition

`auth.type: "digest"` may contain `challengePolicy` with exactly two required own
enumerable data fields:

- `algorithm`: one of `MD5`, `MD5-sess`, `SHA-256`, `SHA-256-sess`,
  `SHA-512-256`, `SHA-512-256-sess`. These are case-sensitive canonical user
  literals. Server challenge algorithm parsing remains case-insensitive and is
  compared in normalized uppercase form.
- `retry`: a strict boolean. No truthiness, numeric/string boolean, or default
  inside a present policy object.

The field is valid only for Digest auth; another auth type carrying it fails
explicitly rather than silently ignoring a requested constraint. This is a
shared model validation rule, not a frontend change.

Omitting the entire policy retains existing auto negotiation and the existing
maximum of one supported 401 challenge retry. A present undefined/null/array,
missing/extra fields, unsupported algorithm or malformed value is invalid.
Direct validation accepts plain/null-prototype own data objects only; rejects
symbols, hidden fields, accessors and custom prototypes without invoking getters
or toJSON. This helper contract does not promise arbitrary JavaScript project
normalization is side-effect free; owner requests are JSON data.

Policy validation occurs before the first network request or connection setup,
not only after a 401. Invalid policy sends zero requests. Existing saved top-level
`auth.algorithm` and `auth.disableRetryRequest` remain ignored as before: this
change does not silently grant previously inert fields operational meaning.

## Challenge and retry behavior

1. With retry true (or legacy omitted policy), send the initial request exactly
   as existing runtime does. No preemptive Digest credentials are generated.
2. Only a 401 can enter Digest challenge processing. Keep the existing bounded
   parser and its malformed/duplicate parameter protections, challenge ordering,
   unsupported-algorithm/qop handling and auth-before-auth-int preference.
3. Select the first supported challenge by the existing algorithm, then apply
   explicit algorithm policy. Mismatch fails closed before sending credentials.
   Do not search later offers for a matching weaker algorithm; an MD5 policy
   cannot skip a supported SHA challenge to select later MD5.
4. A valid matching challenge produces at most one retry with the exact prepared
   entity bytes/content type and the original absolute deadline. Existing cookie
   isolation, cancellation, TLS/proxy handling and request bounds remain intact.
   A failed authenticated response, uncertain transport outcome, timeout or abort
   cannot produce a third request. Each new execution starts a fresh challenge;
   no realm/nonce/cnonce/nc/opaque is persisted in auth definitions.
5. With a valid retry:false policy, return the first response, including a 401,
   without parsing its challenge, generating Digest Authorization, or sending a
   second request. Malformed challenge text is irrelevant in this disabled path.
   Existing first-response cookie/finalization behavior remains unchanged.

Fixed error categories must not echo challenges, arbitrary policy keys,
credentials or original exceptions containing them. Direct digestAuthorization
callers receive the same policy validation/selection restriction; disabled policy
returns no generated authorization. The transport must skip the helper entirely
on disabled retry, not accidentally parse its challenge.

## Persistence and interoperability

The policy is ordinary saved request configuration, preserved in frozen plans,
backups and restored projects; it is not a capability or host authorization token.
Existing owner/MCP/CLI execution permissions and project isolation still apply.
Only definitions carrying the new explicit field gain the constraint.

The later native adapter will reject all nonempty native challenge/preemptive
state rather than discard it. Native algorithm default MD5 and retry switch must
be explicitly represented, not mapped into unrestricted legacy auto negotiation.
That future adapter is a Workbench 401-only safety bootstrap, not a promise of
original 401/403 behavior or token-byte equivalence. Existing Postman Digest import
limitations are not silently fixed or reused as a native safety validator here.

## Acceptance

- Pure exact schema/descriptor/redaction matrix and all six algorithm variants.
- Independent real HTTP digest verification, multi-offer precedence and mismatch
  refusal, unsupported leading offer, malformed preferred offer, empty/no-Digest
  challenges, retry:false with malformed 401 and ordinary non-401 response.
- No policy preserves prior behavior, including ignored old top-level fields;
  invalid policy has zero connections/requests, no credentials leaked in errors.
- Matching auth/auth-int and session variants; prepared multipart/binary bytes,
  content type/length retained exactly, challenge cookie refresh, concurrent
  identities, fresh nonces/cnonces, failed credentials and original deadline /
  cancellation prevent replay loops. Existing PR 20 suites stay intact.
- Real owner persistence/frozen plan/restore/restart plus official SDK and CLI
  execute saved policy definitions under existing project permissions.
- This narrow base has no redirect-following module: test 3xx is returned without
  automatic follow or credential forwarding. Root opt-in redirect combinations
  are tested later during minimal root integration, not by expanding this base.
- Only ordinary CI runs applications/HTTP peers. Local work is static, syntax and
  formatting. No VM/job budget increase, hidden retries, skipped assertions or
  original-runtime acceptance claim.
