# Recursive reference siblings and portable export

## Failure

OpenAPI 3.1 Schema references can carry sibling constraints. The bounded resolver
preserved those constraints while expanding a reference, but returned only `$ref`
when it encountered that reference again. A recursive child could consequently
lose `required`, property constraints or `unevaluatedProperties` at the cycle
boundary. This changed which payloads were accepted rather than just their display.

## Decision

At a repeated 3.1 Schema reference, retain the unresolved reference and visit its
children using the same typed Schema traversal. Do not expand that root reference
again. Schema children still receive reference validation; examples, defaults and
extensions remain literal data. Existing depth/node limits and the prohibition on
automatic external-reference downloads remain unchanged. Other reference modes
and legacy document versions retain their prior resolution behavior.

The application exports OpenAPI 3.0.3. Its Reference Object does not apply sibling
properties, unlike a 3.1 Schema reference. In Schema positions only, export a
reference with siblings as an `allOf` reference member, with the siblings on the
enclosing Schema Object. Prepend to, rather than replace, existing `allOf` members.
Keep property-local constraints outside that reference member; do not flatten
properties across reference boundaries. Bare references remain unchanged. Reject
non-string references and empty composition arrays instead of silently repairing
them. Count the additional reference member against the existing resource budget.

This is not a complete 3.1-to-3.0 conversion. Unsupported keywords such as
`unevaluatedProperties` still cause an explicit export error; original project
export remains the lossless alternative. No remote schemas are downloaded.

Specification: https://spec.openapis.org/oas/v3.0.3.html#reference-object

## Evidence

Four failing regressions reproduced dropped recursive constraints, reference
sibling export, persistence/reimport changes and invalid-schema repair. Independent
Ajv 2020 validation compares source and resolved payload acceptance at multiple
recursion depths, including unevaluated-property scope. Additional cases cover
nested references in recursive siblings, literal payload references, depth limits,
existing composition and local additional-property constraints. Project JSON
persistence, actual OpenAPI export and reimport are exercised separately from
direct normalization. These checks do not establish native Apipost interoperability.
