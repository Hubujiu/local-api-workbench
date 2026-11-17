# OpenAPI 3.1 constant and numeric-bound portability

## Feature and scope

OpenAPI 3.1 request/component schemas already import, but common `const` and
numeric `exclusiveMinimum` / `exclusiveMaximum` constructs could not be exported
through the existing OpenAPI 3.0.3 exporter. This change implements equivalent
3.0 schema constraints rather than adding a new refusal:

- Non-null JSON constants become singleton enums. If an enum already exists,
  preserve it and conjoin the constant through `allOf`; conflicting constraints
  remain impossible, and JSON object equality does not depend on property order.
- Numeric exclusivity becomes a 3.0 Boolean flag plus its bound. A stricter
  existing inclusive bound remains inclusive. Equal bounds remain exclusive.
  Lower/upper contradictions, nonnumeric instances and other constraints keep
  their original meanings. Existing 3.0 Boolean exclusivity is unchanged.
- All existing Schema positions are converted, including nested schema keywords,
  parameters, response/header/content, components and callbacks. Examples,
  defaults, extension values and the contents of constant data remain literal.
- Reference siblings still use Schema Object `allOf`, not ignored Reference
  Object siblings. No input is modified. Literal traversal uses the existing
  node/depth limits and rejects non-JSON values, sparse arrays and accessors.

The output remains OpenAPI 3.0.3. Top-level `const:null`, nullable type arrays,
`prefixItems` and other unsupported dialect features still reject. This is not
complete dialect conversion, a Schema engine change or a restart of the paused
Schema/runtime investigation. Original stored schemas are not rewritten.

## Evidence and verification

Initial new pure suite on the unchanged baseline: 12 tests, 3 passed and 9
failed because supported constructs could not export. See `red.output.txt`.
The final suite has 13 cases, including a project import/export/reimport fixture
used by CI. Differential validation uses Ajv2020 for the original schema and an
independent interpretation of 3.0 Boolean exclusivity for the target. Assertions
also check target shape, so invalid numeric 3.0 exclusives cannot hide behind the
oracle. Candidates include boundaries, negative/subnormal/extreme finite values,
nonnumeric values, compositions, references, constant/enum intersections and
nested JSON values. Related reference suites plus this suite: 25/25 pass.

Two new owner / official SDK HTTP workflows are authored and syntax-checked
locally, not executed locally. They cover import, source disk/full Store
immutability during export, component/parameter/response schemas, server restart,
reimport, real request body/query wire, and unrelated project isolation. Ordinary
CI must verify them against the published commit before completion is claimed.

The old boolean-schema rejection test now uses `const:null` and malformed
exclusive string instead of the newly supported constructs. Its expectations
for remaining unsupported syntax and existing Boolean exclusivity are retained.

A local validation deviation is recorded explicitly: an attempted negative
`--test-name-pattern` filter did not exclude the existing server-backed final
case in `openapi-boolean-schema.test.mjs`. All 9 tests ran and passed, including
that one runtime case. That command is not a pure-test result and is not used as
substitute evidence for the new CI workflows. It was reported immediately and
not repeated; subsequent local verification uses known pure files only.

No original Apipost execution, SQL Server license acceptance, Oracle image,
native-format inference, restricted export-integration retry, cancelled multipart
publication, merge or deployment is included.
