# Bounded OpenAPI Query arrays

## Defect and scope

Previously the importer retained an array example but dropped its serialization
contract; the HTTP/cURL path called `String(value)`. For example `["a,b","c&d"]`
became one `q=a%2Cb%2Cc%26d` value, rather than default OAS3 repeated keys. Export
also discarded `explode`. This change is backend-only and does not expand the
script VM, frontend, global-parameter model or dependencies.

Supported imports are OAS3 Query `style: form` with boolean `explode` (default
true), and Swagger2 Query `collectionFormat: multi` or `csv` (default csv).
Parameter-level example, a single named inline example, or schema/default values
are selected without network access. Swagger items/default are retained. An
absent example/default becomes `[]`: a definition with no emitted query value,
not an invented executable value. Unsupported Query content, objects, nested
arrays, type unions/compositions, other styles/formats and `allowReserved: true`
fail before an imported batch is committed. Both example and examples together
are rejected, as are malformed supplied null/type values.

Specification references:
- https://spec.openapis.org/oas/v3.0.3.html#parameter-object
- https://spec.openapis.org/oas/v2.0.html#parameter-object

## Canonical contract

One logical query row retains its array schema/items and a string value containing
JSON array text. Its explicit closed marker is:
`querySerialization: {version: 1, style: "form", explode: boolean}`.
Unmarked legacy rows keep their existing execution behavior; array semantics are
never inferred from old schema or value text. Marker properties must be own,
enumerable data properties with no unknown/symbol/hidden/accessor fields. The
marker is valid only on Query rows, and is preserved by normalizing, freezing,
storing and restoring the request.

The array has 0–1000 elements and at most 64 KiB JSON text. Items have an explicit
string/number/integer/boolean schema and matching primitive values; unsafe integer
numbers, nulls, objects and arrays are rejected. This is a type/encoding boundary,
not full JSON Schema validation (enum/range/pattern constraints are not evaluated
here). Empty string elements are explicitly unsupported in this first slice,
including with queryAddEqual=false; `[]` emits no pairs and survives export. This
avoids confusing empty arrays, empty elements and flag-style parameters. Disabled
rows still require a well-formed definition but do not contribute wire values.

Each key and element is RFC3986 percent-encoded independently, including !'()*.
Exploded arrays produce repeated encoded names. Non-exploded arrays join encoded
elements with literal commas: an element's comma stays `%2C`, while a delimiter
stays `,`. Each encoded logical parameter and all active array query contributions
are bounded to 64 KiB; names are 1–1024 UTF-8 bytes. Invalid Unicode fails closed.
Unrelated existing raw URL query spelling, unmarked form encoding, API-key
replacement and authentication signature construction remain unchanged. HTTP and
cURL share the codec; signatures consume the resulting URL as before. The
separate AWS Query presigner reconstructs query values from decoded pairs; it
would erase CSV delimiter/element distinctions. Active nonempty non-exploded
arrays therefore reject `auth.type: aws` plus `addAuthDataToQuery: true` before
execution. AWS header authentication, exploded arrays and omitted arrays are not
blocked by this compatibility guard; no signing algorithm is changed.

Static JSON text is parsed before template interpolation; scalar elements are
interpolated and safely reserialized so quoted or backslashed variable values
cannot change JSON syntax. Templates are supported in string items, not coerced
to numeric/boolean items. Dynamic results must produce a valid array (or its JSON
text) within the same limits. MCP temporary input for a marked row must be an
actual JSON array and is validated without changing the stored request. Active dynamic
array definitions are rejected by OpenAPI and cURL definition export rather than flattened to their
stored baseline; project backups preserve them.

## Export and explicit boundaries

OpenAPI export emits one array parameter with a typed example and explicit
form/explode/allowReserved:false; it does not create invalid duplicate parameter
definitions. Logical arrays do not relax the existing rejection of unrelated
same-name rows/raw URL collisions. SDK URL mode is a separate opt-in contract and
currently cannot preserve this marker; normalizing, initializing, resolving and
definition-exporting that combination reject explicitly before metadata is lost.
Ordinary script mode and its existing budgets are unchanged. Root integration must
also guard native-format exporters that do not support this new representation.
No claim is made for every Apipost original import behavior, advanced Query styles,
SDK URL mutation of arrays, or a lossless archive of every original annotation.

## Verification

Pure codec tests cover exact wire spelling and independent element decoding,
OAS3/Swagger defaults, empty definitions, booleans/zero, raw-query preservation,
closed metadata, schema/shape errors, malformed Unicode and allocation/output
bounds. Backend workflow tests are authored for ordinary CI and cover actual
HTTP, owner import, MCP sync and SDK HTTP/stdio, temporary inputs, frozen plans,
CLI, export/reimport, backup/restore/restart, and atomic negative paths. No local
application, network, VM/XML, real database or pressure workload is used to validate
this slice. Actual CI results must be attached to the exact pushed commit; merely
authoring these tests does not establish acceptance.
