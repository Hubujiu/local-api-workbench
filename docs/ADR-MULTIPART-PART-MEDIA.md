# Explicit multipart part media types

Status: frozen contract, implementation and CI acceptance pending.

Feature branch `feat/multipart-part-media-types` starts at develop
`88f70bb515c48b93536b28b7fe3ec780f2e150f3`. This is independent of PR51's
Postman mode/GraphQL import changes. Integration must preserve those changes.

## Defect and contract

The public Postman v2.1 schema permits `contentType` on text and file formdata
entries (https://schema.postman.com/collection/json/v2.1.0/draft-07/collection.json).
The importer discarded this field and the sender emitted no text-part media and
always application/octet-stream for files. An explicit JSON metadata part thus
silently changed meaning.

Canonical multipart rows may carry optional, literal `contentType`. Validate with
the existing MIT jshttp/content-type 1.0.5 parser, promoted from the lockfile's
existing development dependency to a direct runtime dependency. No new package
bytes or custom general MIME parser are needed. Preserve the original valid ASCII
header bytes, including case and parameters; reject empty/non-string/over-1024-byte
values, controls, wildcard media and variable templates. Explicit metadata is
only valid for form-data. Omitted properties remain omitted: old hashes and wire
defaults do not change. Validation applies before any network activity, including
restored/frozen/direct requests and disabled rows. Disabled entire Postman bodies
continue to ignore inactive body data when composed with PR51.

The sender uses the explicit type for enabled text/file parts. File selection
remains explicit and `requiresFile` is not cleared by import; source paths are
never read. Existing request/body limits, authentication, cancellation, persistence
and script budgets remain unchanged. Script text updates preserve existing row
metadata through the existing previous-row copy; no new VM API is added.

OpenAPI and cURL export explicitly reject this metadata until a separately
verified equivalent exporter exists. Native export keeps its existing refusal.
Project backups are the lossless interchange. No native-format equivalence, MIME
sniffing, body conversion, external resources, arbitrary part headers or frontend
controls are added.

## Acceptance gate

Pure validation checks and syntax/format are permitted locally. Actual application,
network, SDK, CLI and restart workflows run only in ordinary push CI. A real
multipart receiver must verify complete part header/body bytes for explicit JSON
text, a selected binary file, omitted defaults, duplicate keys and disabled parts.
Owner import/save, HTTP and stdio SDK execution, frozen CLI runs, later live edits,
backup/restore and fresh restart must preserve the media and independent snapshots.
Invalid media, mixed imports, unsupported exports and missing selected files must
leave state unchanged and send no requests; another project must remain unchanged.
Safety checks and limits are retained. Until exact-commit CI is inspected this is
work in progress, not delivery acceptance.

## Implementation checkpoint

The canonical validator, Postman projection and sender now preserve explicit media.
A small own-property accessor aligns validation and emission: inherited properties
cannot become new part headers. OpenAPI/cURL refuse even disabled explicit media.
The existing MIT parser has been promoted in both manifest and lockfile; desktop
production installation therefore retains it. No VM implementation was changed.
Existing script item updates keep prior metadata; deliberate whole-body replacement
creates new rows and does not guess media by key.

Four reviewed pure-helper tests pass locally. Three application specifications
cover actual owner import/save, exact multipart bytes (including binary payload),
file reselection refusal, both official SDK transports with denied project isolation,
CLI frozen execution after live edits, unchanged bytes on unsupported export,
backup/restore/restart and explicit restored execution. Invalid source/save/execute,
mixed-import and restored media reject without peer connections. Script item update
preserves type while whole-body replacement restores the omitted-media default.
Only syntax and formatting were checked for these application tests; they remain
pending ordinary exact-commit CI. No application, VM or network workload ran locally.

## Selected OpenAPI form encoding validation

Validate the entire selected multipart/urlencoded `encoding` map before building
rows. Previously only schema/example row keys were inspected; orphan entries and
null/primitive entries could be accepted and silently disappear during export.
Present maps and entries must be non-null, non-array objects. Every entry must
refer to an own, safe schema property (example-only names do not declare one).
Absent maps, empty maps and empty entries on declared properties retain defaults.
Nonempty entries, including legal Encoding Object `x-*` extensions, remain
**unsupported**, not purportedly invalid OpenAPI. An `x-*` key in the encoding map
is a property name and still requires a matching schema property. JSON/raw media
handling is unchanged; this is not validation of unselected media alternatives.

The OAS Media Type Object requires encoding keys to be schema properties:
https://spec.openapis.org/oas/v3.0.3.html#media-type-object and
https://spec.openapis.org/oas/v3.1.1.html#media-type-object.
An OAS `contentType` can select a serialization strategy, not just a MIME header:
for example an application/json string requires JSON quoting. Our literal part
media implementation sends the existing bytes; it is not an OAS JSON codec.
OAS 3.1 `contentEncoding` also concerns transfer encoding. This change neither
implements transfer encoding nor fixes/expands existing base64-file import
interpretation. No custom part headers, object/array codec, reference resolver,
security budget or dependency change is included.

Data-only cases cover malformed maps/entries, orphan/example-only/prototype keys,
extensions, own-property membership, accepted defaults and semantic roundtrips.
CI-only workflows cover mixed-operation JSON/YAML owner rejection, both official
SDK sync transports, unchanged project/config/history bytes and no peer connection,
positive sync/export/import, frozen execution, backup/restore and restart. They
remain unverified until ordinary exact-commit CI completes.

## OpenAPI schema transfer boundary (2026-10-29)

Selected multipart imports now fail closed for any own `contentEncoding`
(including identity and malformed values), without pretending these declarations
are all invalid schemas. No transfer codec or Content-Transfer-Encoding writer
is implemented. Internal file values being base64 does not mean their wire bytes
are base64: runtime decodes storage and sends raw bytes.

Import receives the document version explicitly. OAS 3.0 `format:binary`
remains a raw-file placeholder; multipart `format:byte` is unsupported. In
OAS 3.1, format is an annotation, not a transfer instruction, so byte/binary
strings remain text within multipart (the pre-existing URL-encoded binary rejection is unchanged). Fixed 3.0.3 export rejects multipart contentEncoding,
format:byte, and a text field's format:binary rather than reinterpret these
saved declarations as legacy wire semantics. Actual file/binary still exports.
This gate is only interchange: backup/restore and persisted schemas are not
rewritten or blocked, and no runtime behavior is changed.

URL-encoded byte strings retain literal base64 text and ordinary URL encoding.
JSON/raw content annotations are untouched. This is not complete OAS 3.1 binary
support. Schema contentMediaType does not override the Encoding Object's
explicit or default contentType; no MIME or codec is inferred from it.

Sources:
- https://spec.openapis.org/oas/v3.1.1.html#working-with-binary-data
- https://spec.openapis.org/oas/v3.1.1.html#encoding-multipart-media-types
- https://spec.openapis.org/oas/v3.0.4.html#encoding-multipart-media-types
- https://json-schema.org/draft/2020-12/json-schema-validation#section-8

Reviewed pure-helper tests cover these guards and controls. Added real owner
JSON/YAML, mixed-import atomicity, HTTP/stdio SDK sync, exact wire controls,
project isolation and legacy backup/restart/export-error workflows are ordinary
CI-only evidence; they have not been run locally.

### First transfer-boundary CI and corrected evidence contract

Ordinary feature run 40960879939 failed on all three core jobs: four older
fixtures used 3.1 format:binary while asserting 3.0 raw-file semantics, and two
new transport workflows expected the transfer guard from YAML strings.
Those failures are retained, not reclassified as passed or rerun.

The first diagnosis incorrectly generalized the MCP JSON-only parser to owner
import. The follow-up ordinary run 40962018793 exposed that mistaken expectation:
owner YAML reaches the guard, whereas MCP YAML fails before it. That run is also
retained as failed (including the separate pre-existing macOS script-quota timing
failure); no budget change or manual rerun is used.

The statically verified call chain is:
- owner `server.mjs` import route -> `importIntoProject` -> `importDocument`:
  both helpers have JSON parsing with bounded YAML fallback;
- `syncMCPOpenAPI`: string documents go through `JSON.parse` before calling
  import, without YAML fallback.

Owner JSON and YAML must therefore match the actual OpenAPI guard prefix.
MCP JSON must match that guard; MCP YAML proves parser rejection only.
Both error paths retain unchanged state and no network request. No parser was
added or changed to satisfy these tests. Legacy file fixtures explicitly use
3.0.3; dedicated 3.1 literal byte/binary and downgrade-rejection controls remain.
