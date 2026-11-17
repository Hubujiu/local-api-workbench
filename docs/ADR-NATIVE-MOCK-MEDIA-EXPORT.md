# Bounded native Mock scalar and literal-text definition export

The existing native Mock importer already represents schema roots string, number,
integer, boolean and null with `serialization: scalar-text`, and schema-free
responses as their original raw string. The exporter now mirrors those same
representations, retaining the entire schema rather than sampling or replacing
it with a generated literal. Literal text is emitted unchanged as `raw` with an
empty schema; no JSON/JSON5 parse, whitespace cleanup or template evaluation is
performed. Existing object/array schemas and raw JSON remain supported.

The existing complete `prepareNativeMock` readback plus deep equality remains
mandatory. Normalization, size/schema validation, status, headers, delay, rules,
disabled entries, fallback, and source identity validation are unchanged. XML,
raw-xml, unknown serialization, references, executable source scripts and
unsupported project dependencies continue to reject before returning an export.
Declared sourceStatus is retained; actual HTTP remains the existing fixed 200
contract. Definitions do not imply execution evidence or original-product parity.

## Evidence and compatibility boundary

Legally obtained original static `mock.asar` SHA256
`615038524b769a7bd5233ae200fb263e13195ef814f38c7fa00a105ee9cfdee8`
contains `server.js` (archive byte offset 98308536, size 34899), SHA256
`317c5e22d425790f4ee677ab6b9d5e4a5bbe0c6d3bf0c943e0c4e7f9c339ff88`.
Read-only lines 242–251 select schema generation; 274–322 convert scalar output
to text; 329–334 parse raw with JSON5 and emit JSON on success, retaining raw
only on parse failure (95–101 stringify JSON). Consequently original execution
may normalize single quotes/comments/spacing. We preserve native definitions and
current Workbench wire behavior, **not** original byte-for-byte wire parity. No
original runtime was run and no proprietary code was copied. Synthetic fixtures
are independently authored, not purported original scalar export captures.

## Verification

A real owner export initially returned 400 for an already executable literal
response in the new whole-flow fixture. Before that actual RED, the test setup
used two nonexistent Store module paths; those fixture errors were corrected to
the existing runtime export and are not product failures. The narrow adapter
change makes the same owner path succeed without changing import or transport.

The whole fixture covers all five scalar schemas (including unchanged enum),
objects/arrays, empty/raw scalar/Unicode/template-looking/JSON5-looking text,
both native formats through two generations, rule matching, disabled precedence,
fallback, headers, declared status and real delay. Independent consumer plans
save actual two-response evidence; Mock and consumer backups are restored,
owner server is closed/reopened, disk history is re-read, and source/third-project
isolation is asserted. Existing negative export tests retain XML, unsupported
serialization/schema/reference/project-dependency rejection and input atomicity.
Exact-head CI is recorded in PR14; local checks alone are not full acceptance.
