# Managed OpenAPI response examples

## Import and representation

New OpenAPI imports materialize every inline response example for concrete
100–599 statuses, rather than only the first JSON value. JSON media are preferred
for default ordering; textual media, XML/+xml, JavaScript, GraphQL text and form
text use literal strings. Empty strings and JSON false/zero/null remain distinct.
Swagger 2 response `examples` are normalized into media entries too.

Named example summaries are editable labels. Descriptions and extension metadata
remain in source definitions. External/no-value definitions are retained with an
import note, never fetched or executed. Ambiguous example/examples or
value/externalValue combinations, malformed maps, binary/unsupported inline media,
and non-string textual values fail explicitly.

Each request is bounded to 1000 example entries and 8 MiB aggregate body text.
Source fingerprints use bounded canonical annotation data, at most 100000 nodes
and 64 levels per annotation. They are integrity markers, not credentials.

## Editing and export

New imports carry version-1 source bindings and an annotation fingerprint registry
inside the native project. The flat examples are the editable body-case view;
source response definitions retain schemas and original annotation metadata.
Export rebuilds their inline examples from the edited cases, so edits, deletion,
new cases, and moves to another status/media do not resurrect stale source values.
Descriptions/extensions and external definitions are retained. Multiple manual
cases receive collision-safe named entries, including identical labels.

Visual response-status changes move associated source bindings and cases that
have not independently changed status. Moving a definition with bound examples
to a wildcard/default status is rejected before mutation. Raw edits to source
example annotations are detected as conflicts rather than silently overwritten;
use the example editor, or re-import the revised source. Schema-only changes do
not invalidate annotation fingerprints. Unsupported binding versions fail.

Existing unbound projects retain their prior source-annotation precedence; this
change does not silently reinterpret old stored source metadata. Native project
export retains all working data. OpenAPI body examples do not encode per-case
Mock delay or arbitrary per-case response headers; Content-Type selects media.
JSON bodies must parse as JSON, rather than becoming quoted strings on export.
The existing bounded OpenAPI 3.0 schema exporter remains in use.

## Verification

Tests cover all inline values/media, no-op roundtrip, edit/delete/add/move,
metadata preservation, external definitions, conflicting source edits, duplicate
bindings, limits, prototype-looking example names, Swagger examples and actual
persisted HTTP Mock selection. Browser coverage imports two cases, edits one,
deletes the other, changes the response status visually, downloads an OpenAPI
export and re-imports that artifact without restoring the deleted case.

Reference: [OpenAPI 3.1 Example Object](https://spec.openapis.org/oas/v3.1.0.html#example-object).
