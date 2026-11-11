# Marked parameter schema source isolation

## Defect and bounded fix

On the PR168 baseline, a Query array or Header object imported with an undefined
variable in `schema.example` or `schema.default` still required that old variable
after a complete MCP temporary override or a fixed dynamic replacement. The
selected normalized value had been replaced correctly, but generic recursive
interpolation also visited the retained Schema.

The fix extends the existing Cookie-object/reserved-query isolation only to rows
with the established Query-array or Header-object serialization marker. It
preserves their Schema unchanged while interpolating the rest of the request,
then restores it before the existing resolved-value checks. The array codec
consumes literal `items.type`; the Header-object codec consumes literal primitive
property types, declared properties and additionalProperties. Their schema
example/default fields select initial values at import, not additional values
at execution. Type/shape checks still run against the resulting actual value.

No generic Schema evaluator is introduced. This does not imply full JSON Schema
constraint validation. Ordinary unmarked parameter schemas, request/response
schemas, authentication, URL, assertions, scripts and other established runtime
interpolation remain unchanged. The original source operation is already opaque
on this baseline; that existing rule is not broadened here. Real unresolved
variables in active values continue to fail, and replacement values still reject
incorrect types. Stored definitions and frozen snapshots retain source templates.

## Verification scope

The focused pure matrix covers parameter-level examples and schema example/default
sources, both marked parameter kinds, temporary input and fixed dynamic values,
JSON quoting/Unicode, unchanged provenance and source objects, absent active
variables and bad resolved types. A boundary test keeps ordinary schemas,
response schemas, authentication and assertions on their original interpolation
path. Existing dynamic-value and authentication suites remain regression gates.

Official MCP HTTP/stdio workflow coverage verifies actual transport bytes,
zero-network failure without replacement, complete replacement without providing
the obsolete variable, and saved/frozen definition isolation. This is a runtime
correctness fix, not new serialization support or a GUI acceptance claim.

Local verification on this candidate: focused tests 5/5; expanded OpenAPI,
Cookie, MCP input, dynamics, signing/authentication, HTTP/2, code generation,
global parameters, response mutation and schema-assertion regression 406 total,
405 passed, zero failed, one Go-toolchain-unavailable skip. Syntax and full-format
checks passed. The focused workflow suite is separate from that 406-test batch.
No full repository-suite or remote CI result is claimed.

Evidence is under `docs/evidence/parameter-schema-source/`. The red capture shows
three pre-fix missing-`unused` failures. During focused test development a negative
case initially passed an own `live: undefined` property; existing interpolation
regards that as defined. It was corrected to omit the key, not by changing runtime
behavior. The final focused suite verifies true absence.
