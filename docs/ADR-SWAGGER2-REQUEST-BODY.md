# Bounded Swagger 2.0 request-body migration

## Evidence and reuse

At baseline `88f70bb515c48b93536b28b7fe3ec780f2e150f3`, `importDocument`
accepted `swagger` but passed only `operation.requestBody` to the OAS3 body
importer. Its parameter mapping consumed query/path/header/cookie, not
`body`/`formData`. Thus valid Swagger payload definitions became `bodyType:none`.
This is source-inspection evidence, not a locally executed HTTP RED. The first
test-only commit failed with a missing new converter module, not a behavioral
reproduction of that old defect.

Primary references reviewed on 2026-10-28:

- [Apipost manual import](https://wiki.apipost.cn/docs/project_set/import_project/manual_trigger/)
  explicitly includes Swagger 2.0.
- [OAS 2.0](https://spec.openapis.org/oas/v2.0): path/operation parameter
  identity and overriding, at most one body, body/form exclusion, operation
  `consumes` override, Schema `example`, and scalar parameter `default`.
- [OAS 3.0.3 Request Body Object](https://spec.openapis.org/oas/v3.0.3#request-body-object):
  whole-body requiredness is separate from required object properties and defaults
  to false. Any required Swagger form parameter therefore also sets canonical
  `requestBody.required:true`; an entirely optional form leaves it absent.

The implementation reuses `resolveLocalReferences`, `importOpenAPIBody`,
`exportOpenAPIBody`, the schema-position visitor and existing transport encoders.
The new pure adapter only bridges resolved Swagger parameter definitions to that
existing request-body contract; it has no network, filesystem, VM or new library.

An established full converter was considered: the upstream
[swagger2openapi README](https://github.com/Mermade/oas-kit/tree/main/packages/swagger2openapi)
documents `convertObj` and reference/repair options; its
[package metadata](https://raw.githubusercontent.com/Mermade/oas-kit/main/packages/swagger2openapi/package.json)
declares version 7.0.8, BSD-3-Clause and additional resolver/fetch/validator
dependencies. Those are moving upstream sources, not a pinned compatibility
oracle. It was not installed or copied. Adopting a whole-document converter would
add dependencies and require alignment of reference, repair, authentication and
transport policies beyond this authorized no-new-dependency fix. Existing mature
project body/schema machinery is reused instead of writing a second encoder.

## Contract

- Input version is explicitly `swagger:"2.0"`, without a mixed `openapi` marker
  or OAS3 `requestBody`. Within each parameter list duplicate `(in,name)` pairs
  reject. Operation entries override the same path-level pair; different names
  do not remove inherited entries. The effective list may contain one body or
  formData fields, never both.
- Body/form definitions require a nonempty effective `consumes`. An own operation
  value overrides the document, including an empty list, which rejects rather
  than falling back. Selection follows the existing OAS3 editor policy: exact
  case-insensitive `application/json` first, otherwise the first declared media.
  An unsupported selected media rejects, rather than searching for a convenient
  alternative. Multiple alternatives produce a note identifying the selection;
  this is not a lossless archive of all media variants.
- Body supports existing JSON/+json and literal text media. `schema.example`
  becomes the editable payload, using property presence (including null, false,
  zero and empty text). Without an example, the existing editor uses `{}` for
  JSON and empty text for text bodies. Schema defaults are preserved, not
  substituted into a generated body; no claim is made that the draft validates
  against the schema. There is no recursive sample generation or XML parsing.
  Parameter required/description/extensions are preserved on the canonical
  requestBody. The body parameter's documentation-only name is not archived.
- FormData supports scalar text/number/integer/boolean fields and their existing
  default-to-editor-value policy. Defaults are type checked, preserving false,
  zero and empty strings. Required names, descriptions, supported scalar
  constraints and extensions become object properties/required metadata.
  Defaults are editor initial values, not a claim that the specification requires
  a client to send them. File parameters require multipart and become
  `requiresFile:true` placeholders. No file paths, default file contents or inline
  bytes are read. Files must subsequently be explicitly selected through existing
  authorized mechanisms.
- Array fields, collectionFormat, custom form serialization/media parameters,
  ambiguous binary-form strings, multipart names containing control characters,
  quotes or backslashes (not faithfully handled by the existing encoder),
  unsupported body/form parameter fields,
  unresolved recursive body references and discriminator conversion reject.
  Ordinary acyclic local references resolve through the existing resolver first;
  literal `$ref` inside examples/defaults/extensions is data. External references
  retain the existing no-fetch refusal. This is not a complete Swagger validator.
- The new operation projection strips `consumes`/`produces`/`schemes` and carries
  canonical requestBody annotations. OAS3 export already rebuilds `parameters`,
  so old body/form parameters are not leaked into its parameter array. Responses
  still use the existing `produces` conversion before projection. Explicit
  operation `schemes` is rejected, not silently removed as though its URL override
  had been honored. Existing document-level host/basePath/schemes handling stays
  unchanged. OAS3 imports do not enter the adapter.

## Boundaries and acceptance

### Request media and reserved Content-Type parameters

The first real PR55 CI (`40699181604`) reached OAS3 export/reimport and exposed
duplicate enabled Content-Type headers for JSON, text and urlencoded requests.
The exporter wrote both the canonical header as a Parameter Object and the body
media; the importer appended both. Transport correctly rejected the duplicate.
The later CLI/restore/SDK steps had not executed, so that run is not evidence of
their acceptance. Multipart did not duplicate because its boundary/header is
generated by the transport. This is behavioral CI evidence, independent of the
initial missing-module test stage.

[OAS 3.0.3 Parameter Object](https://spec.openapis.org/oas/v3.0.3#parameter-object)
requires a header parameter named Content-Type to be ignored. OAS3 import now
does so case-insensitively, with or without a requestBody, and gets its single
Content-Type from the selected body media. This rule applies to input document
parameters, not to deleting headers from users' canonical requests. Accept and
Authorization conversion remain separate existing boundaries, not newly solved
by this fix; Swagger's parameter path is unchanged.

Export omits the reserved Content-Type parameter only after checking the enabled
canonical header against the body mode. JSON/+json, supported literal text media
and urlencoded preserve their full compatible media value, including charset, in
`requestBody.content`. Disabled rows are not conflicts. More than one enabled
Content-Type, dynamic/non-media values, incompatible media/body modes and an
explicit header with no supported body reject rather than choose a value or
silently discard it. This deliberately tightens export's preservation boundary:
the former no-body output used an ignored header parameter and did not actually
provide a standards-compliant roundtrip. The old removed-body test now first
expects that explicit conflict, then disables the header before retaining its
original assertion that a removed body is not resurrected.
Multipart uses the existing generated-boundary contract;
an explicit bare multipart media is redundant, while an explicit boundary or
other custom multipart media parameters reject. Unsupported export shapes can
use the project backup, which preserves the canonical model. This is not a new
promise of general wire-lossless OAS export (for example, existing defaults for
raw bodies without an explicit header are unchanged).

These pure header/media helpers reuse the existing body converter. They do not
change request encoding, duplicate-header safety, runtime budgets or the original
CI workflow assertions. The original workflow must still execute its unchanged
export/reimport requests successfully on the new exact head.

This is not a full Swagger-to-OAS3 migration: securityDefinitions/auth migration,
advanced parameter serialization, recursive definition registries and all
transport variants are not implemented here. The complete acceptance fixture is
plain unauthenticated HTTP with document-level host/basePath/schemes. Existing
MCP/active OpenAPI sync remains OAS3-only; imported canonical requests/plans can
use existing execution/read tools. No original GUI, frontend, dependencies,
runtime budgets, DB, XML/VM specialist work or pressure tests are added.

The pure tests import only the converter and existing pure body helper. Local
verification is limited to those tests, syntax and formatting. Full owner import,
HTTP wire, freeze/live isolation, persistence/restart/backup restore,
OAS3 export/reimport, CLI and official SDK workflows are for ordinary CI only.
Invalid mixed batches must leave memory/disk unchanged and send nothing;
unselected file execution must send nothing. Exact-head CI is separately tracked;
local converter passes are not whole-workflow acceptance.
