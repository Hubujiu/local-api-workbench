# Restricted OpenAPI Query object form/explode serialization

## Scope and provenance

Based exactly on PR169 head `7209638aede4e5c114355b9dd9fd6dfb72342af3`.
This is an independently implemented bounded contract, not general object Query
support, a full JSON Schema validator, or a native Apipost compatibility claim.

The [OAS 3.1.1 style examples](https://spec.openapis.org/oas/v3.1.1.html#style-examples)
and [RFC6570 form Query expansion](https://www.rfc-editor.org/rfc/rfc6570.html#section-3.2.8)
specify that an exploded object contributes property names, not its outer
parameter name: `filter={role:"user",count:1}` becomes `role=user&count=1`.
This differs from deepObject and from a JSON-valued scalar Query.

## Supported contract

- OAS3 `in: query`, `style: form` (including its default), `explode: true`
  (including its default), and `allowReserved: false` or absent.
- An explicit non-null object schema with nonempty `properties` and
  `additionalProperties: false`; each property has an explicit primitive
  string/number/integer/boolean type. No nested or composed type declarations.
- A selected nonempty object example/default is required. Parameter `example`
  wins, then a single inline `examples` value, then schema default/example.
  Ambiguous, external and unsupported initial values reject, not coerce.
- Both outer identity and property names are literal ASCII identifiers matching
  `[A-Za-z_][A-Za-z0-9_.~-]{0,127}`; prototype-related names are excluded.
  Names are never template-expanded. Ordinary unrelated row names retain their
  existing runtime interpolation, with collision checking after resolution.
- Scalar values remain strongly typed; nonfinite/unsafe integers, empty strings,
  controls, invalid Unicode, null, nested arrays/objects and empty objects reject.
  The JSON value and encoded object each have a 64 KiB limit, with at most 1000
  properties and a 64 KiB aggregate encoded-object budget.
- Schema annotations are retained as source metadata, not interpreted as extra
  live values. This does not promise enforcement of all JSON Schema constraints
  such as enum, pattern, required, or numeric bounds.

The versioned row marker is
`queryObjectSerialization: {version: 1, style: "form", explode: true}`.
Unmarked JSON-looking strings never acquire object serialization automatically.
Only Query rows may carry the marker, and malformed or disabled markers are
validated rather than silently discarded.

## Encoding and collisions

Values are raw data, **not pre-encoded**. Literal `%2F` (three characters) is sent
as `%252F`; `/` is sent as `%2F`. Reserved delimiters, quotes, brackets, plus,
Unicode and spaces are percent-encoded; spaces use `%20`. This intentionally does
not inherit the pre-encoded percent contract of the separate allowReserved
scalar feature. Property order follows the stored JSON object's entry order.

An active object may not produce a name already produced by an ordinary scalar,
array or another object. Active outer parameter identities must also be unique
when an object is present, so complete MCP replacement cannot ambiguously target
multiple definitions. No implicit overwrite, deduplication or priority is used.
These checks run on definitions and on the resolved request before network I/O.
Shared parameters and BEFORE-script mutations pass through the same request
validation; stored definitions do not become permission to skip final checks.

The first slice rejects URL-embedded Query, including a Query introduced by
runtime variable interpolation. It does not reconstruct original URL parameters
and does not claim original URL byte-preserving OpenAPI roundtrips.
`queryAddEqual:false` is also rejected. The existing fragment-append serializer
handles supported generated Query pairs, rather than mutating URLSearchParams.

## Authentication, scripts, lifecycle and exports

Only `none`, `basic`, and `bearer` auth are admitted. Query API keys, OAuth variants,
AWS signatures/presigning, and other authentication types are explicitly outside
this first slice; their existing support for other parameter types is unchanged.
No claim about signatures over exploded objects is made. SDK URL mode/runtime
is rejected at both full-request and low-level facade entrypoints, including
disabled object rows. Ordinary BEFORE/AFTER scripting remains available.

MCP temporary input addresses the **outer parameter identity** and supplies a
complete object, replacing rather than merging its prior value and dynamic
source. Native JSON types are checked before serialization. Dynamic results and
interpolated leaf values are validated before serialization reaches the wire.
Source schema example/default and retained OpenAPI provenance remain opaque;
real missing variables in active values still fail.

Store, project backups and frozen plans retain the explicit marker, source schema
and object JSON value. Editing live definitions must not rewrite old snapshots.
OpenAPI export restores the outer object parameter, style, explode and example;
it also checks effective shared auth/Query, rejecting shared Query that would be
omitted by the existing exporter (freeze the definition or use project backup).
This is serialization preservation, not a new promise of auth-policy roundtrips;
active dynamic definitions cannot be exported as static OpenAPI or cURL. Native
Apipost JSON/directory exports refuse the marker, including disabled rows and
frozen definitions, instead of flattening it into misleading scalar parameters.

## Acceptance

The tests cover real HTTP/1, HTTP/2 and cURL targets, official MCP SDK HTTP and
stdio execution, full replacement, quoting/Unicode/percent behavior, source
metadata, frozen plans, backup/restart, and rejected collisions/unsupported modes.
Pure codec checks cover bounds, malformed markers and schema/type boundaries.
Native export tests include frozen samples/plans and malformed marker presence.

No original proprietary program is executed, and no new account, subscription,
license, merge, deployment or remote publication is part of this implementation.

Final local evidence: focused 16/16; expanded 398 total, 397 passed, one missing-Go
toolchain skip, zero failures. Focused tests are included in the expanded count.
Syntax, full source-format and diff checks passed. Details and commands are in
`docs/evidence/openapi-query-object-safe/README.md`; no full-suite/remote-CI claim.
