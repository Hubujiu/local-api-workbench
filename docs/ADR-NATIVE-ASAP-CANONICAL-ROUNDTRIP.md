# Native ASAP canonical definition roundtrip

Status: approved implementation contract; implementation and runtime acceptance pending.
Base: PR 14 exact `df307234dbd914d64833c1101b922dea4012375c`.

## Goal and evidence

Add native JSON and directory definition import/export for a bounded ASAP subset,
using the existing Workbench signer unchanged. This is semantic canonicalization,
not exact field-presence preservation, original execution acceptance, or token-byte
compatibility. No original application is executed.

The legally obtained Apipost 2.0.0 package SHA256 is
`7c66b8963960dd22a384072ecb714c9d8ba1164bb2ecd8f2d90d325fa3d83942`.
Its decoded `send-index.js` SHA256 is
`5dabd6d0b85214084895a7044f9b045bb005cb010ecec156e98cf883a914ceff`.
Static character offsets 10043444–10044480 map eight native fields; 27785616
lists the parameters, 27785776 declares the 3600-second expiry and handler
algorithm defaults, and the handler around 27790800 computes expiry as current
epoch seconds plus the supplied duration. These are character offsets, not byte
offsets. Proprietary code is not copied into this repository.

The mapper defaults absent algorithm to HS256, although the handler accepts only
nine asymmetric algorithms. The handler defaults subject to issuer, accepts
claim overrides (including `kid` as a header override), and passes audience
straight to `setAudience`. Workbench instead defaults TTL to 60, omits absent
subject, treats array-looking audience text as JSON, and treats claims.kid as a
payload claim. These differences require explicit rules below. The original
also lacks Workbench's injected JWT typ header; no wire-equivalence claim follows.

## Accepted definition domain and canonicalization

Native own fields are exactly `alg`, `iss`, `aud`, `kid`, `privateKey`, `sub`,
`claims`, `exp`. Workbench own fields are exactly `type: "asap"` and the same
fields with `ttlSeconds` replacing `exp`. Unknown fields fail closed, even empty;
no fields are silently dropped from the selected definition. These strict rules
apply to the ASAP section and Workbench definition, not the enclosing native auth
envelope: inactive other sections may coexist and are neither read nor executed.
The adapter reads the type/asap selectors via data descriptors. Direct selected
definition inputs accept only plain or
null-prototype objects with own enumerable data properties; reject symbols,
nonenumerable properties, accessors and custom prototypes without invoking
getters or toJSON. This is a helper boundary, not an arbitrary-JavaScript
project-normalization guarantee. Owner inputs are JSON data. Errors are fixed,
redacted categories/paths, never supplied keys, claims, credentials, or PEM bytes.

- Native alg must explicitly name RS256/384/512, PS256/384/512, or ES256/384/512.
  Missing/empty native alg is rejected, not interpreted as RS256. Workbench
  missing/empty alg exports explicit RS256, matching its existing signer.
- Native missing/empty exp imports numeric ttlSeconds 3600. Workbench
  missing/empty ttlSeconds exports numeric exp 60. Otherwise accept only an
  integer number 1..3600 or canonical decimal text matching `[1-9][0-9]*` within
  that range. Preserve accepted number/string representation; reject whitespace,
  signs, fractions, leading zeroes, loose parseInt suffixes, and templates.
- iss and kid are literal strings satisfying existing identifier limits and
  syntax (200/500 characters, no empty/dot/dot-dot path segments); kid starts
  with `iss + "/"`. No dynamic identity fields.
- Native missing/empty sub imports the explicitly validated nonempty issuer.
  Otherwise sub is a literal nonempty string of at most 500 characters.
  Workbench missing/empty sub is rejected on export: filling issuer would change
  its existing omission semantics. No template expansion occurs.
- aud is a literal nonblank single string, at most 200 characters, whose trimmed
  form does not start `[`. Preserve whitespace/text. Reject arrays, array-looking
  strings, and template-bearing values, rather than silently changing claim type.
- privateKey is a bounded (64 KiB), literal inline unencrypted PKCS8 PEM with
  BEGIN/END PRIVATE KEY labels. Preserve LF/CRLF and body bytes. Reject data URIs,
  percent-encoded keys, encrypted/legacy RSA/EC PEM labels and templates. This is
  only envelope validation: conversion does not parse keys or promise that the
  key is valid, strong enough, or suitable for the algorithm.
- Missing/empty claims canonicalizes to the string `{}`. Otherwise preserve raw
  JSON text exactly, limited to 4 KiB, parsing only to require a JSON object and
  reject own keys iss, aud, sub, iat, exp, jti, kid (including falsy values).
  Reject templates anywhere in claims text. Other custom payload fields remain
  allowed. The extra kid rejection is adapter-only, based on the original header
  override mismatch; ordinary Workbench signing behavior is unchanged.

Export checks its inverse: importing the produced native section must equal the
canonical Workbench definition. Import/export/reimport is stable on that
canonical definition, not the original omitted-field shape. No export signing,
key parsing, token acquisition, template evaluation, network access, or secret
redaction inside private native backups. Public OpenAPI authentication mechanism
projection must not expose private key or claims content.

## Execution and atomicity

All existing signing safety gates remain authoritative: algorithm/key type,
RSA strength, EC curve, identifier validation, bounded claims, nbf timestamp,
clock, TTL and protected claims. Definition acceptance does not imply execution
validity (for example a syntactically shaped but invalid key or future nbf can
still fail at execution). No signer, VM budget, grant, or transport relaxation.
Execution is explicit and signs an Authorization Bearer token only.

Unsupported definitions fail whole import/export atomically with no partial
artifact/project mutation and no outbound execution. Preserve inherited own,
parent and noauth boundaries, frozen snapshots, backup/restore project isolation,
and existing CLI/MCP permissions. Secret-bearing error messages are forbidden.

## Acceptance and delivery

1. Pure accepted/rejected matrix for every field, defaults in both directions,
   nine algorithms, number/string TTL, raw JSON and PEM line endings, unknown
   fields, templates, protected/kid overrides and inverse canonical stability.
2. Both native formats through real owner import/export, save/reopen and backup
   restore, then explicit execution with independent crypto verification for all
   nine algorithms. Verify kid/iss/sub/aud/custom claims, TTL relative to iat,
   fresh valid jti, Authorization placement and no unintended HTTP on errors.
3. Actual CLI and official SDK MCP execution of reimported definitions; public
   OpenAPI secret exclusion uses same-auth fixtures, not empty stand-ins.
4. Root-only inheritance graph preserve/flatten import, own/noauth, frozen plans
   and restored execution are added during minimal root integration, not by
   broadening PR 14's dependency base.
5. Ordinary CI performs runtime acceptance. Local work is static/syntax/format
   only. Failed CI evidence is retained; no budget increases, hidden retries,
   skipped cases or original-runtime claims.

Implementation stages: contract; bounded converter and pure tests; full owner /
CLI / SDK workflow; independent feature CI; minimal root graph integration and
complete root CI plus actual portable-package byte verification.
