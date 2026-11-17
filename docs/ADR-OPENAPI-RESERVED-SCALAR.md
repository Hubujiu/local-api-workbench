# Restricted OpenAPI scalar allowReserved

This slice implements OAS 3.0/3.1 `in: query`, `style: form`, primitive-schema
parameters with `allowReserved: true`. It is not complete reserved expansion,
array/object Query support, or unrestricted raw-query injection.

## Stored contract

`reservedQuerySerialization: { version: 1, style: "form", allowReserved: true }`
is explicit, versioned definition data. Unmarked scalar rows keep their existing
form encoding. The marker is accepted only on Query rows; unknown/malformed
markers and unsupported combinations reject even when disabled. No encoding is
guessed from a string's appearance. Schema constraints beyond primitive shape
remain metadata, as for existing scalar parameters; this is not a JSON Schema
validator. The implementation accepts stored string, finite safe number and
boolean values, and checks temporary/dynamic values before string coercion.

## Input and wire semantics

Values are URI-template input, not guaranteed decoded application text. Valid
UTF-8 percent triplets are already encoded and are preserved with their original
hex case. For a literal percent sign, supply `%25`; `%2F` means an encoded slash,
not the literal three-character spelling. Malformed percent escapes/UTF-8 are
rejected, not guessed or repaired. No decode/re-encode cycle is used.

The safe reserved characters `:/?@!$()*,;` remain literal. `[]#&=+` are encoded
because they are not legal Query data or are form syntax. Unreserved characters
remain literal; remaining characters, spaces and Unicode become UTF-8 percent
encoding. Raw controls and raw apostrophes are refused. Apostrophe is legal in
RFC reserved expansion but WHATWG special-URL query assignment rewrites it; this
slice does not pretend to preserve that spelling. An already encoded `%27` is
supported. Input and encoded output are bounded to 64 KiB; parameter names are
ordinary-encoded, never reserved-expanded.

The contract follows RFC6570 3.2.1 and OAS Appendix C.4.2/E.1's distinction between
reserved expansion and query/form legality:
- https://www.rfc-editor.org/rfc/rfc6570.html#section-3.2.1
- https://spec.openapis.org/oas/v3.1.1.html#c-4-2-expansion-with-non-rfc6570-supported-options
- https://spec.openapis.org/oas/v3.1.1.html#e-1-percent-encoding-and-form-urlencoded

Encoded fragments are appended through the existing raw-spelling-preserving
Query assembler. Existing URL Query text, duplicate fields, order, `%2f`, bare
parameters and `+` spelling are not rebuilt with URLSearchParams. Percent-encoded
`&`/`=` remain inside one parameter; raw values cannot create a second field.
Empty values produce `name=`. `queryAddEqual:false` is refused in marked requests.

## Restricted combinations

- Only `none`, `basic` and `bearer` authentication are currently admitted. Other
  auth modes, including AWS Header/Query, OAuth1/OAuth2, JWT, Hawk and EdgeGrid,
  remain rejected until actual wire/signature fidelity is independently proved.
  The current AWS Query presigner rewrites the whole Query string.
- SDK URL mode/state is rejected; its provenance model only supports raw/form.
- Arrays, objects, content parameters, type unions/compositions, non-form style,
  Swagger 2.0 allowReserved and malformed non-Boolean flags remain rejected.
- The first slice does not add complex global/folder parameter support.
- Active dynamic definitions refuse cURL/OpenAPI definition export. Resolved
  execution definitions can be used; project backups preserve dynamic sources.
- Apipost JSON/directory export refuses the marker, including frozen definitions;
  it cannot silently discard the wire contract.

## Lifecycle and source data

Import chooses explicit scalar examples using the existing scalar selector.
OpenAPI export retains `style: form` and `allowReserved: true`; reimport preserves
wire behavior. Marked requests whose URL already contains a Query refuse OpenAPI
export: its existing projection cannot preserve arbitrary raw spelling. Runtime
and cURL still support those URLs without rewriting them. Store, backups and frozen requests retain the descriptor. MCP and
dynamic values revalidate primitive values and encoding before execution. The
retained `openapiOperation` and marked row's schema are definition metadata, not
secondary runtime templates; replaced examples cannot demand unused variables.
Actual Query values, auth and unrelated existing runtime templates still resolve.

## Follow-up

Open signatures only after independent server/oracle checks; add SDK URL state
support before enabling it. Arrays need element/delimiter contracts, especially
CSV commas. This work does not relax request budgets, script sandboxes, auth
algorithms, replay rules or existing confirmation boundaries.
