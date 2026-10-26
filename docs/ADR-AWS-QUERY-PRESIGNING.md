# Bounded AWS S3 query authentication

## Scope and authority

The backend supports the explicit boolean `auth.addAuthDataToQuery` for canonical
AWS requests and Postman AWS import. Missing/false retains Header signing. The
new true branch supports **S3, GET/HEAD, and an empty serialized body only**.
Other services, methods, and nonempty bodies fail before network access rather
than silently switching authentication modes. No frontend controls, AWS account,
credential discovery, dependency upgrade, or new license acceptance are added.

The initial defect was a Postman import with `addAuthDataToQuery: true` losing
that setting. Its saved/restored request sent Header authentication to a local
Query-only verifier and received 403. Persisting the flag without changing the
actual request URL would not fix this defect.

## Contract

- The flag is strictly boolean; strings, numeric switches, null, and duplicate
  Postman flag entries are rejected. Requests, shared authentication, frozen
  plans, Store saves, and backup restoration retain/validate the same field.
- `X-Amz-Expires` may occur once, with exact case and a canonical decimal integer
  from 1 through 604800. Its default is 86400 seconds. There is no new persistent
  expiry field. Temporary credentials may expire or be revoked **before** this
  interval ends; the interval is not an authorization guarantee.
- Other pre-existing generated signing Query parameters, case variants, and
  mixed SigV4a `X-Amz-Region-Set` are rejected. Expiry duplication is rejected.
  Ordinary duplicate query values retain their relative order; spaces use `%20`
  and reserved characters use RFC3986 encoding. The renderer is a small encoding
  adapter, not a cryptographic implementation.
- S3 object paths must already have canonical RFC3986 UTF-8 encoding. Validation
  occurs before the runtime's first WHATWG URL parse. Dot segments (including
  encoded combinations), backslashes, raw reserved/non-ASCII path characters,
  lowercase percent escapes, encoded unreserved characters, malformed UTF-8,
  and incomplete Unicode are rejected rather than selecting a different object.
  Canonical encoded Unicode, `%2F`, `%252F`, and repeated `/` remain supported.
  This is a bounded path contract, not arbitrary original URL byte parity.
- The decoded query key `__proto__` is rejected, including percent-encoded
  spellings: the installed Smithy 5.7.4 canonical serializer cannot represent
  that key faithfully. No vendor patch or dependency upgrade is included.
  The old Header-signing behavior is otherwise unchanged; this is not a claim
  that every existing Header-mode edge case is repaired.
- The original URL and authentication definitions never receive generated
  signature fields. Each execution builds a new runtime-only URL and header map
  after final body serialization. Query signing removes stale Authorization,
  date, and security-token headers. Ordinary `x-amz-*` headers remain signed
  headers, not hoisted Query values; collisions with Query keys are rejected.
  Host must agree with the URL. Nonzero Content-Length and Transfer-Encoding
  are not permitted for this empty-body profile.
- Limits remain bounded: 10000 input Query pairs, 64KiB per explicit credential
  string, and 1MiB for the resulting signed URL. No ambient credentials are read.

## Open-source reuse and signature evidence

The existing Apache-2.0 `@smithy/signature-v4` 5.7.4 public `presign` API performs
signing. An internal `x-amz-content-sha256: UNSIGNED-PAYLOAD` sentinel drives its
payload selection; the sentinel is excluded from canonical headers/hoisting and
removed before transmission. It is **not** a guarantee that a payload is signed;
this first slice prohibits nonempty payloads.

The production signer and a separate test verifier using `node:crypto` both
match the [AWS published S3 Query example](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sigv4-query-string-auth.html).
The [official S3 presigner source](https://github.com/aws/aws-sdk-js-v3/blob/main/packages/s3-request-presigner/src/presigner.ts)
also documents the UNSIGNED-PAYLOAD profile. Tests do not call the production
signer to produce their server-side expected HMAC.

Independent loopback HTTP/HTTP2 services verify the actual method, path, query,
host, and signed headers. They reject altered queries/tokens/signatures and
expired URLs. All credentials are fictional. These tests prove local wire
signature behavior, not access to a real AWS bucket or original-product runtime
equivalence.

## Persistence, isolation, and nonclaims

Postman import → frozen canonical plan → real execution → saved result → backup
restore → fresh Store instance is exercised, including concurrent projects with
different identities and live API edits that must not replace frozen auth.
Failed evidence storage does not cause another network request. The signature
and signing time are regenerated on each execution; definitions are unchanged.

**Storage is not secret-free.** Existing request/plan definitions and execution
snapshots may contain explicitly saved `auth.secretKey`. Actual wire evidence
records the signed URL and may include `X-Amz-Security-Token`; that URL can be
reused until its authorization ceases to be valid. Treat project files, backups,
run/history records, and exported evidence as sensitive. No blanket redaction or
secure-erasure guarantee is introduced. The secret key is not added to the
outgoing URL/headers by signing.

The independent feature branch does not include the separate native Apipost
auth adapter. Native flag mapping requires its own combined acceptance. Native
plan-step authentication overrides and native MCP input-auth restrictions are
not broadened by this change. No multipart uploads, other AWS services, SigV4a,
automatic refresh, redirects, or arbitrary S3 paths are claimed.
