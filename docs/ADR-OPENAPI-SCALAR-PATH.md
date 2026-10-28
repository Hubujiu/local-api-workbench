# Bounded OpenAPI 3 scalar path serialization

This change fixes an admitted definition losing `style: label/matrix` between
import, request execution and OpenAPI export. It is not general RFC6570 support.
Reference: https://spec.openapis.org/oas/v3.0.3.html#parameter-object and
https://spec.openapis.org/oas/v3.0.3.html#style-examples .

## Closed contract

OpenAPI 3 path rows carry `pathSerialization: {version:1,style,explode}`.
Simple (default), label and matrix support string, finite number/integer and
boolean schemas. The marker is required for this codec; unmarked native,
Postman and Swagger rows retain their previous behavior. No query codec is
reused or changed. Parameter-level examples preserve their JSON scalar type,
including zero and false. Whole-value `{{variable}}` bindings preserve JSON
number/boolean types; mixed interpolation is string-only. Raw variables,
MCP overrides and dynamic results are checked before generic stringification.
Dynamic function outputs must match the scalar schema. No environment, script
or dynamic function is executed by definition export.

All marked names are safe ASCII names (1–100 characters), unique, `required:true`,
enabled and present exactly once as a whole pathname segment. Substitution
never targets authority, query or fragment. Single-slash service-relative paths
remain valid definitions and use the existing explicit service binding at execution;
network-path (`//authority`) references are not admitted. Values use strict percent encoding
(including `!'()*`); only the codec inserts label `.` or matrix `;name=`. An
already-percent-looking value is data and is encoded once, not decoded.
Final `.`/`..` segments are rejected before WHATWG URL normalization can erase
them. Controls, invalid Unicode, compound/null values and non-finite numbers fail
without echoing sensitive values.

Missing parameter examples remain unbound `value:""`, may be saved and exported
without inventing an example, and fail before network execution until bound.
Explicit empty examples are rejected on import, not confused with missing ones.
Empty runtime values are outside this slice (including spec matrix `;name` and
label `.`). Schema defaults/examples remain schema metadata, not runtime values.
Arrays/objects, nullable/composed path schemas, parameter `content`, named
`examples`, partial/duplicate placeholders, disabled required rows and unsafe
names are unsupported and fail explicitly. A dynamic/template-bearing row must
use project backup rather than exporting a fabricated static OpenAPI example.
SDK URL mode is unsupported for marked rows, including preexisting runtime
state; the closed sandbox facade has an inline refusal, not a host-codec import.

## Consumer and persistence contract

The ordinary HTTP wire path and cURL use the same serializer. Normalization and
Store admission validate live rows and frozen plan snapshots. Backup/restart/
restore preserve the marker; OpenAPI exports style/explode and typed examples.
MCP temporary values do not alter stored requests. Native exporters in the root
integration must reject marker presence (including malformed/disabled rows)
rather than erase it; the isolated develop base does not contain that exporter.
The separate native-inheritance graph boundary is unchanged.

## Evidence boundary

`path-serialization-pure.test.mjs` runs only inspected, I/O-free helper and MCP
input code locally. `path-serialization-workflow.test.mjs` is authored for normal
CI: real loopback wire targets, owner CRUD/import/export, cURL, reimport, frozen
plans, save/restart/backup/restore, scoped official MCP HTTP temporary inputs,
dynamic/template type checks, atomic rejection and no-network failure paths.
Local application/VM/XML/database tests are not executed. CI must pass for the
exact published revision before these application workflows are called verified.
