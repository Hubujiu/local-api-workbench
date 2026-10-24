# Boolean Schema fidelity

## Problem and decision

Truthy defaults and object spreading changed `false` schemas into `{}` during
request normalization, OpenAPI import, and local-reference resolution. That
changes “accept no value” into “accept any value”. Preserve boolean schemas in
stored requests, parameter definitions, supported form schemas, and local
references. A false reference with siblings uses `allOf` to retain both the false
constraint and the sibling annotations; a true reference with siblings retains
those sibling constraints.

The exporter still targets OpenAPI 3.0.3. It converts schema-position `true` to
`{}` and `false` to `{ "not": {} }`, retaining the constraint rather than emitting
an unsupported standalone boolean Schema Object. Boolean `additionalProperties`
is already permitted and is retained. This is semantic preservation, not
byte-for-byte preservation of the source document.

The traversal explicitly follows request/response media, parameters, headers,
components, and callbacks. Example/default/enum payloads and extension values
remain data, including properties literally named `schema`. Exported values are
cloned; source requests are not rewritten. Node and depth budgets fail explicitly.

## Supported boundary

Schema keywords outside the OpenAPI 3.0 supported set, union/null types, and
numeric exclusive bounds now fail export with an explicit message rather than
being presented as valid 3.0 constraints. Original project JSON export remains
the lossless storage route for unsupported dialect constructs. This is not a
general OpenAPI 3.1-to-3.0 conversion, a complete document validator, or a fix for
every existing object-reference composition and form-schema round-trip gap.

The representation follows the [JSON Schema basics](https://json-schema.org/understanding-json-schema/basics)
and [OpenAPI 3.0.3 Schema Object](https://spec.openapis.org/oas/v3.0.3.html#schema-object).

## Verification

Tests reproduce all coercion paths before the fix, then check normalization and
JSON persistence, local references, supported nested schema positions, form
roots/properties, parameters/responses/components/callbacks, untouched boolean
example data, unsupported dialect rejection, and bounded cyclic-input failure.

A real HTTP save/restart/export test also verifies durable workbench storage.
The existing browser fixture containing `$defs` now explicitly checks 3.0 export
rejection; its separate response-export assertion uses a supported request
schema without modifying the stored advanced schema.
