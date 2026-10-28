# Preserve selected OpenAPI scalar parameter values

## Defect

OAS3 scalar Query and Cookie import used `parameter.example ?? schema.default ??
""`; Header import used only `parameter.example ?? ""`. A single named inline
example was ignored. For a boolean Query with `schema.default: true` and
`examples.only.value: false`, the editor and HTTP request used `true`. A named
zero or empty string was likewise replaced by a default or empty fallback.
Header schema defaults and all three locations' schema examples were ignored.

The complete original operation is retained as source metadata, but it does not
repair the executable definition: OpenAPI export rebuilds its Parameter Objects
from the canonical rows and emits `example: row.value`. Export/reimport therefore
cements the wrong selected value even when the old source metadata or a project
backup still contains the original example. This is an import-to-wire-to-export
workflow defect, not a transport boolean-stringification defect.

## Bounded import-only contract

For OAS3 scalar Query/Header/Cookie parameters, use own-property presence:

1. A supplied `example`, or exactly one named inline `examples` entry with an own
   `value`. The two parameter fields are mutually exclusive.
2. Otherwise an own Schema `default`.
3. Otherwise an own Schema `example`.
4. Otherwise the existing location-specific fallback (normally empty text).

Step 2 before step 3 is the workbench's existing default-to-editor policy, also
used by its independently supported query arrays. It is **not** a precedence
rule imposed by OpenAPI, nor a requirement for a client to send a server default.
No schema sample generation or remote example download is introduced.

Selected strings, booleans and finite safe numeric values retain their JSON
types. False, zero and explicit empty text do not fall through. Numeric-looking
and boolean-looking strings remain strings. Unsafe integral numbers, nonfinite
numbers, null, undefined and compound selected values reject rather than being
coerced or mistaken for absence. This is not full Schema validation: constraints
and type compatibility remain metadata, not a new validator. Missing values keep
the old fallback; this change does not preserve the definition-level distinction
between absent and explicit empty examples that the current exporter collapses.

Multiple or malformed named examples, missing values, `externalValue`, residual
`$ref`, and simultaneous parameter `example`/`examples` reject the entire import
before project mutation, even if a default could otherwise be used. Existing
local-reference resolution runs first, so acyclic local Parameter/Example
references work without fetching anything. Literal extensions remain data.
This does not alter the general Reference Object sibling contract.

Explicit compound schemas (arrays, objects, unions/compositions), content-encoded
parameters, path parameters and Swagger imports retain their existing owners and
behavior. They are not newly supported or newly validated by this scalar helper.
Root integration must call the scalar selector **only on the non-array branch**
of the existing query-array importer, after array admission has selected its own
codec. The feature branch does not copy the cumulative root's modules.

## Compatibility and export

There is no new row marker or runtime, VM, SDK, signing, credential, encoding,
front-end or dependency contract. Canonical rows and old stored string values
are not reinterpreted; source imports are the only changed behavior. Reserved
header filtering remains owned by the existing importer. No authentication
definition is converted into executable credentials.

The existing typed `example: row.value` export now carries the selected value
through fresh import. A single named example is canonically exported as a direct
example; its name/summary are not promised as an equivalent operation-parameter
archive. Use project backup for source metadata. Native exporters retain their
existing text-only row/Schema guards: numeric or boolean selected rows must not
be silently stringified to make native export succeed. MCP temporary inputs may
use their existing text coercion, but only on a cloned request; stored typed
definitions remain unchanged.

## Verification

Pure helper tests cover source precedence, false/zero/empty and string spelling,
invalid choices, nonfinite/unsafe values, literal templates, source immutability,
and exclusion of compound contracts. These alone are permitted locally.

Ordinary-CI workflows cover actual echo HTTP wire values, cURL, owner import/save,
typed OpenAPI export and fresh reimport, backups/restoration, process restart,
frozen plans after live edits, local references and operation overrides, scoped
MCP sync/execution and temporary-input isolation. Rejections cover mixed valid
and invalid operations through owner import, direct sync, and official HTTP and
stdio SDKs with all four cover modes; source, project and project-directory bytes
must remain unchanged. External example URLs are fictional and must never be
accessed. The workflows are authored/syntax-checked, not run locally; exact-head
CI results are required before claiming end-to-end acceptance.

Primary sources:
- [OAS3 Parameter Object](https://spec.openapis.org/oas/v3.0.3.html#parameter-object)
- [OAS3 Example Object](https://spec.openapis.org/oas/v3.0.3.html#example-object)
- [OAS3 Schema Object](https://spec.openapis.org/oas/v3.0.3.html#schema-object)
