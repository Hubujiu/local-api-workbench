# Explicit Cookie object pairs

## Scope and source contract

This bounded feature supports a flat primitive object parameter with
`in: cookie`, `style: form`, `explode: true` and the explicit extension
`x-local-api-cookie-dialect: cookie-pairs-v1`. Omitted style/explode use their
form/true defaults, but the extension is mandatory. A source without the
extension is still refused rather than silently assigned a wire interpretation.

This is an implementation-defined Cookie-pairs contract, **not** a claim of a
unique interoperable OpenAPI form serialization. OAS 3.1.1 Appendix D explains
the ambiguity and the mismatch between form expansion and Cookie separators:
https://spec.openapis.org/oas/v3.1.1.html#appendix-d-serializing-headers-and-cookies

The canonical row retains typed schema and JSON object text with:

```
cookieSerialization: {
  version: 1, style: "form", explode: true, dialect: "cookie-pairs"
}
```

`{role: "a;b", active: false}` produces `role=a%3Bb; active=false`.
The logical parameter name is not sent; property names become Cookie names.
Names are case-sensitive ASCII Cookie tokens, 1..1024 bytes, excluding
prototype-sensitive names. Values use UTF-8 percent encoding of all characters
except RFC3986 unreserved characters. An input `%3B` becomes `%253B`, not a
pre-escaped semicolon. A consumer must use the matching decoding convention.
An empty object emits zero Cookie pairs. The codec does not infer a marker from
an object schema or JSON-looking ordinary text.

## Deliberately unsupported

- `explode:false`, alternative styles, content parameters, arrays, null or nested
  values, general composition, nullable schemas, and const+enum intersections.
  A const+enum intersection would export as allOf, outside this first slice;
  it is refused up front rather than generating a non-reimportable definition.
- Full JSON Schema validation. Enum, required, range and pattern constraints are
  metadata, as in the existing Header object subset, not validated assertions.
- Non-raw Cookie encoding policies combined with any marked row.
- Marked objects in global/folder parameter definitions. Existing simple defaults
  still apply; their effective names participate in expanded collision checks.
- Native JSON/directory export of the marker; these formats have no verified
  equivalent, so the export refuses instead of dropping it.

The selected source example follows parameter example, one inline examples value,
schema default, schema example, then empty object. Conflicting or ambiguous
examples are refused. Properties/additionalProperties can declare explicit
string, number, integer or boolean types, checked against actual values. Objects
have at most 1000 properties and 64 KiB JSON text; encoded contributions and the
whole mixed Cookie header are bounded to 64 KiB. Disabled marked rows still need
valid definitions. A disabled marked row still activates the raw-policy and
ordinary-row byte/name checks: disabling it is not an implicit downgrade to the
legacy contract. No script/network budgets or authentication algorithms change.

## Assembly, precedence and persistence

A shared pure assembler supplies HTTP/1.1, HTTP/2, cURL and code-generation
headers. Active logical Cookie names must be unique in a marked request; actual
expanded property names may not collide with another object or ordinary Cookie
row. Ordinary values in the same marked request must be legal Cookie octets,
preventing a raw scalar from injecting another pair. Unmarked requests keep their
existing bytes, duplicate rules and encoding policies.

Explicit Cookie Header rows and API-key authentication targeting the Cookie
Header are refused when an active object is present, rather than silently losing
that header or authentication. Existing managed Cookie jar precedence remains:
an enabled jar replaces the assembled Cookie header, and an empty enabled jar
removes it. This behavior is tested with the real project jar. The new module
does not merge jar state into definitions or backups.

Store, backups, frozen plans and MCP temporary input preserve the descriptor.
MCP overrides take a real object, remove its dynamic source and leave the stored
request untouched. Literal template interpolation parses JSON first, interpolates
string values, then serializes it again so quotes/backslashes cannot change the
object grammar. Dynamic values are revalidated after evaluation. Active dynamic
object definitions refuse cURL/OpenAPI definition export instead of exporting a
stale baseline; resolved execution definitions remain available.

OpenAPI export reconstructs a typed example and the dialect extension. A second
import retains the same wire convention. Generic project backup is the portable
lossless alternative when a target format cannot express the contract.

## JSON object text contract

Like the existing Header-object parser and ordinary JSON import, object text uses
`JSON.parse`: repeated property names resolve to the last value. The codec does
not claim duplicate-key detection or preservation of the original JSON spelling.
Wire serialization and exported typed examples both use that same parsed result;
MCP object input is serialized from an actual object. Prototype-sensitive names
are still rejected after parsing. Schema constraints beyond the explicit shape
and primitive-type admission above remain metadata, not validation assertions.

## Replaced source examples are not runtime inputs

The original `openapiOperation` is retained import/export provenance: execution
uses the normalized URL, authentication, parameter rows and body instead. It is
now excluded from generic runtime interpolation and restored unchanged. Likewise,
a marked Cookie row's schema is kept as literal admitted type/shape metadata;
its old `example` or `default` is not a second runtime value after MCP replacement
or dynamic evaluation. The selected Cookie JSON value is still interpolated and
validated normally, so an unresolved variable in the actual value still fails
before network access.

This fix deliberately does not redesign all template handling. Request-level
`schema`, `responses`, `examples`, other parameter schemas, assertions,
extractions and authentication retain their previous interpolation paths. Tests
verify this boundary and exercise official SDK HTTP/stdio replacement without
defining any old example variable. Preserving schema examples is not bypassing
shape checks: the resolved object is still checked by the Cookie codec before
transmission.
