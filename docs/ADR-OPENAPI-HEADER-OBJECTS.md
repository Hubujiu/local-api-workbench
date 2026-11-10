# OpenAPI simple Header objects

## Delivered behavior

Initially implemented on PR #161 head `71e2bb69d912d2b8a5e0952b3e80c273ab9275be`,
this change is now stacked on PR #163 head
`b3267a9b644f377ab6a3e1046828bb1099cb4bf3`, including PR #162's schema export.
It adds executable OAS3.0/OAS3.1 Header object serialization. It does not
replace the earlier refusal with an import-time string conversion. One logical
Header retains the object schema, selected typed example, and serialization
contract through import, execution, cURL, OpenAPI export, persistence, backups,
temporary input, and frozen plans.

The supported contract is an explicit `type: object` schema with flat primitive
values and `style: simple`. `explode` defaults to false; both false and true are
supported. Properties and typed additionalProperties can specify string, number,
integer or boolean types. No-example definitions use `{}` as an editable empty
value, not a generated schema sample. Example precedence is parameter example,
a single resolved inline examples entry, schema default, schema example, then
`{}`. Ambiguous examples or unsupported nested/composed/nullable schemas fail
before an import batch commits. An explicit type may retain a closed, enum-only
allOf intersection: PR #162 uses this form when converting const plus enum to
OpenAPI 3.0. This exception applies at the object root and scalar property level;
it cannot redefine the wire shape or admit arbitrary composition.

The codec checks value shape, primitive types, safe numeric values, Unicode,
property admission and resource limits. It is not a complete JSON Schema
instance validator: enum, required, ranges and patterns remain schema metadata.
Existing Swagger, scalar, array and manually stored unmarked rows are unchanged.

## Canonical representation

A marked Header row stores JSON object text in value and a closed descriptor:

```
headerSerialization: { version: 1, style: "simple", explode: false }
```

The marker is not inferred from schema or JSON-looking strings. It is accepted
only on Header rows. Marker fields must be own enumerable data properties;
unknown, hidden, symbol, accessor and inherited descriptor fields reject.
Disabled rows must still have valid stored definitions.

Each value has at most 1000 properties and 64 KiB of JSON text. Header names are
valid HTTP field names with at most 1024 bytes. Each encoded value and the sum of
active encoded Header object contributions are bounded to 64 KiB. Content-Type
remains controlled by request-body media, not a Header object row.

## Wire and mutation behavior

For `{role: "a,b=c", active: false}`, the two modes produce:

- `explode: false`: `role,a%2Cb%3Dc,active,false`
- `explode: true`: `role=a%2Cb%3Dc,active=false`

Keys and primitive values are encoded individually before inserting separators.
Unicode uses UTF-8 percent encoding; data commas, equals signs, percent signs,
quotes, line breaks and other reserved characters cannot become wire structure.
An empty object emits an empty Header value; cURL uses its existing `name;`
syntax to send that value instead of suppressing the field.

The HTTP/1.1 and HTTP/2 paths and cURL/code generation share requestHeaderMap and
the same codec. Existing ordinary duplicate Header handling is retained for live
requests and cURL. OpenAPI export refuses duplicate names involving a marked
object because its parameter list cannot preserve that request definition.

Stored JSON is parsed before template interpolation. Only its string values are
interpolated and then safely reserialized. Quotes and backslashes in variables
cannot alter JSON grammar. Dynamic values may produce a flat object or valid
JSON object text and are revalidated after resolution. MCP temporary overrides
must provide an actual object, remove the dynamic source, and never modify the
saved definition.

Script Header readers expose the JSON definition text. Existing upsert and
setRequestHeader operations preserve the marker, so replacement values must
remain JSON object text. Invalid replacements fail before the HTTP request.
Scripts do not mutate the frozen source plan or stored API. No script budget or
sandbox behavior changes.

## Export and compatibility boundaries

OpenAPI export reconstructs one Header parameter with a typed object example,
original schema, and explicit simple/explode fields. Definition export does not
execute dynamic providers: active dynamic objects fail cURL/OpenAPI definition
export rather than being replaced with a stale baseline. Resolved execution
records and full Workbench backups retain their existing roles.

Native JSON and directory formats do not have a verified representation of this
marker. A new presence guard prevents native JSON export from erasing it, even
for bare object schemas or disabled rows. Existing closed native sample/plan
export checks also reject it. No native export capability is expanded. Global
and folder parameter definitions retain their existing simple-row contract.

## Standards and remaining implementation work

[OAS3.1.1 Appendix C](https://spec.openapis.org/oas/v3.1.1.html#appendix-c-using-rfc6570-based-serialization)
relates simple serialization to RFC6570 expansion. This implementation encodes
each component, then adds style separators; it is not HTTP structured-field
serialization. [Appendix D](https://spec.openapis.org/oas/v3.1.1.html#appendix-d-serializing-headers-and-cookies)
warns that Header/Cookie content and style encoding are not interchangeable.

Two other requested gaps remain separate work, not completed by this Header
feature:

1. **Cookie objects.** OAS3.0/3.1 form Cookie serialization has documented
   ambiguities and conflicts between query-style separators and Cookie syntax.
   A future implementation needs an explicitly documented dialect, a versioned
   cookie marker, shared assembly, empty-value behavior, exploded property-name
   collision checks, ordinary-cookie/header interaction, Cookie-jar precedence,
   encoding/signing tests and the same persistence/export/frozen-plan coverage.
   It must not claim universal standards behavior for an implementation-defined
   source contract. Existing refusal is retained until that codec is implemented.
2. **Query allowReserved.** A separate typed/versioned Query contract must retain
   this option through import/export, interpolation and runtime. RFC6570 reserved
   expansion preserves valid percent triplets but does not make illegal query
   characters safe. The codec needs explicit handling of query delimiters, raw
   URL query spelling, empty values, arrays, signing and SDK URL mutations.
   URLSearchParams cannot be used to rebuild the full query without proving that
   those distinctions survive. The prior refusal is not the final implementation.

## Verification scope

New tests exercise OAS3.0/3.1 import/export, local references and path inheritance,
flat dictionaries, false/zero/empty values, descriptor corruption, Unicode and
encoded-size limits. Real loopback workflows cover owner HTTP, HTTP/2, actual
curl, actual CLI, official MCP SDK HTTP and stdio, temporary input, script
replacement, Store reopen, backup restore, frozen plans, project isolation and
atomic failed imports. Native boundaries are checked independently for live
APIs, disabled rows, frozen samples and independent frozen plans.

Exact verification results and remaining platform limits are recorded in
[evidence](evidence/openapi-header-object-serialization/README.md). No original
Apipost runtime, restricted export integration, cancelled multipart publication,
merge or deployment is part of this change.
