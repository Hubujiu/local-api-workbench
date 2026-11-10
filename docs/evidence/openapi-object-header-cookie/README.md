# Reject unsupported OpenAPI Header/Cookie object serialization

Baseline: PR #160, `1f9a6630eee33fca37ec5c0b22aeb9d265086e75`.

Complete pure import and cURL generation accepted OAS3 object Header/Cookie
parameters but produced `x-filter: [object Object]` and
`cookie: prefs=[object Object]`. The transport's ordinary string conversion is
not the source's simple/form object serialization contract.

## Serialization assessment

Bounded flat-object support is feasible, but cannot safely be implemented by
flattening examples during import. Canonical Header/Cookie rows currently omit
style/explode, and OpenAPI export reconstructs parameters from those rows. A
complete implementation needs versioned metadata and a codec shared by runtime,
cURL, import/export, dynamic values, frozen plans and persistence. Exploded Cookie
objects additionally require property-name collision and header-assembly rules.
Unsupported export formats and encoding/signing combinations would need explicit
admission checks. This change implements none of that partial support.

Instead, this bounded fix rejects unsupported object contracts at OAS3 import
admission. Existing saved/manual rows are not reinterpreted. Swagger selection,
ordinary scalars, primitive-array fallbacks, Query arrays and Path serialization
are unchanged. JSON-looking scalar text is not treated as an object.

## Admission boundary

The new wrapper is used only by OAS3 Header/Cookie conversion. It rejects:

- Explicit object schema types, positive compositions/conditional results,
  object-bearing const/enum constraints and object item/contains schemas.
- Known object keywords without an explicit non-object type. This is a
  conservative unsupported/ambiguous serialization boundary, not a claim that
  such JSON Schemas admit only objects or are invalid OpenAPI.
- Selected object values and arrays containing objects, including the actual
  legacy fallback returned by compound selection.
- Parameter content serialization, with a distinct error. No Header/Cookie
  content codec exists, even for scalar media; silently dropping that content
  is not supported.

Traversal follows schema positions, not literal annotations, extensions, $defs
or negative `not` branches, and is cycle-safe. Example precedence stays intact:
an unused object default cannot override an explicit supported scalar example.
OAS3 Content-Type filtering runs first, so ignored reserved parameters do not
block a valid request body. Generic scalar selection and transport are unchanged.

## Evidence

`tests/openapi-object-parameter-admission.test.mjs` on unchanged baseline:
3 passed and 9 failed for missing rejection. With the fix all 12 passed.
Captured RED/GREEN output only has trailing whitespace removed. Four additional
pure helper cases cover fallback selection, precedence, content rejection and
cycles. Independent review caught missing no-example const/enum/contains and
conditional contracts; these are now covered by root and runtime fixtures.
Root tests cover source immutability, ordinary and MCP batch atomicity,
local references/path inheritance, ignored Content-Type, scalar cURL/OpenAPI
roundtrip and legacy/primitive-array controls.
Final related pure suites pass 64/64 with no skips or failures. Independent
review reran 22/22 pure tests and found no remaining blocking issue. Syntax,
whole-repository formatting and diff whitespace checks pass.

Ten owner/official SDK HTTP and actual-wire workflows are authored and
syntax-checked locally; they run in ordinary CI. They compare complete Store
baselines separately from HTTP projections, including definition history, and
check durable files/revisions, other-project isolation, no import-time requests,
Store reopen, and exact scalar/Query-array wire after export and reimport.

Cross-platform acceptance and artifact provenance must be verified for this
commit. No full local runtime suite, original Apipost, native format expansion,
restricted export integration, cancelled multipart publication, merge or
deployment is claimed. PR #160's earlier unexplained macOS failure remains
preserved; its diagnostic-only follow-up was not a demonstrated root-cause fix.
