# Native JWT definition roundtrip (implementation WIP)

## Contract

Continue native export PR14 from exact `25175a1016737c04facb114ed3e02d6315ceb276`.
This is lossless **Workbench definition interchange** through the observed native
JWT envelope, not original-application execution or signature equivalence.

Export `{type: "jwt", jwt: configuration}` using exactly the existing eight
configuration fields: `algorithm`, `secret`, `isSecretBase64Encoded`, `payload`,
`headerPrefix`, `queryParamKey`, `header`, and `addTokenTo`. Reuse the existing
`importJwtConfig` shape contract and verify its inverse. Preserve own-field
presence, omitted defaults, empty strings, boolean versus boolean-string values,
PEM line endings, and original JSON text. Do not fill defaults, parse keys, sign,
resolve templates, contact an endpoint, or acquire credentials during export.
At the direct JWT adapter boundary, unknown fields, accessors, symbols, hidden
properties and malformed field types must reject rather than silently disappear; error messages must not echo field
values or arbitrary unknown property names. Existing import limits and runtime validation remain authoritative and unchanged.
Owner JSON input cannot contain accessors; this is not a new promise to sanitize
arbitrary JavaScript objects before the project exporter normalizes them.

All twelve existing algorithms remain representable: HS256/384/512,
RS256/384/512, PS256/384/512 and ES256/384/512. Representation is not proof that a
configuration can execute: weak or mismatched keys, forbidden headers, invalid
JSON, encrypted keys, unsupported algorithms and other runtime safety violations
remain rejected by the existing signer before network dispatch. A definition may
contain unresolved secret/payload templates; export preserves, never evaluates,
them. No new algorithm, key field, key discovery or token acquisition is added.

Both native JSON and directory export use the same adapter. Existing scope,
source, plan, sample and protocol eligibility rules remain unchanged. This work
does not enable unsupported native plan-step authentication overrides, non-HTTP
JWT, native task export, or flatten an otherwise rejected inheritance graph.
Root-only guards must survive later minimal integration.

Explicit native export and project backup **contain configured secrets**, just as
existing Basic/Bearer/signing exports do. They are not redacted public documents.
Do not include runtime tokens or acquire credentials. Public OpenAPI JWT mechanism
projection remains secret-free; this does not claim that an entire arbitrary
OpenAPI document is secret-free. Errors/diagnostics must not leak secret, payload,
header or private-key text. Owner authorization and project isolation do not change.

## Original static evidence and limits

Legally obtained official Offline 2.0.0 package SHA256:
`7c66b8963960dd22a384072ecb714c9d8ba1164bb2ecd8f2d90d325fa3d83942`.
No original/dependency execution or new license acceptance is involved.

- Renderer `work-index-0d1d8198fa5a.js`, SHA256
  `20bb6e21fd678ead16bd91807dc9623b8cd3e7019d44ac874a167c31a37f39fb`:
  character offsets 2302535 and 2732870 (UTF-8 byte offsets 2305315 and 2796921) identify the eight-field defaults. Other renderer projections use the
  same field names.
- Sender `send-index.js`, SHA256
  `5dabd6d0b85214084895a7044f9b045bb005cb010ecec156e98cf883a914ceff`:
  character offset 10042300 (byte 10044727) identifies the native mapper;
  27858600 (byte 28066153) identifies header/query placement; 27862900
  (byte 28070453) identifies the embedded signer checks.

These are schema evidence, not a promise of original runtime compatibility.
The mapper uses truthiness/default coercion, whereas Workbench preserves its
existing boolean-string and empty-prefix semantics. The embedded original signer
parses and reserializes payload JSON; Workbench preserves payload bytes. The
native mapper exposes `secret`, while the embedded handler expects `privateKey`
for non-HMAC algorithms; no verified connecting transformation establishes native
asymmetric execution. We do not invent that field or restrict existing Workbench
algorithms under a misleading claim that a smaller subset proves equivalence.
No proprietary source is copied into the repository.

## Acceptance (pending ordinary CI)

- Strict inverse checks cover all eight fields, omission/empty/type fidelity,
  templates, LF/CRLF PEM and JSON byte preservation, twelve algorithms and
  malformed/unknown/accessor/hidden/symbol rejection without source mutation.
- Authenticated owner workflows export both native formats, save/reopen/restart,
  backup/restore, reimport and explicitly execute Header and Query JWT. Independent
  Node crypto verification checks signatures, protected headers, payload bytes,
  query collision/location and project isolation, without calling the production
  signer as its oracle. Frozen definitions remain independent of later live edits.
- Rejected export returns no partial definition, changes no project/disk state and
  sends no HTTP. Execution-invalid preserved definitions still fail under existing
  signer safeguards with zero destination traffic. Public OpenAPI projection must
  contain no configured signing material; native export intentionally retains it.
- Existing auth-export, JWT, native JSON/directory, storage and entrypoint tests
  remain regression gates. No budgets, retries, VM worker, dependencies, frontend,
  production signing behavior or licensing scope changes.

No local application, VM, database or network-provider runtime is run for this
slice. Syntax/format checks are not runtime acceptance. Original interoperability
and full native parity are explicitly not established by Workbench CI.
