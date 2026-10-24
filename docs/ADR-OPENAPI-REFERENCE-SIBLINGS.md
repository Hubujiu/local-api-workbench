# OpenAPI 3.1 reference sibling constraints

## Decision

For OpenAPI 3.1 Schema Objects, a local reference and its sibling constraints
must both apply. A shallow object spread can weaken minimum lengths, replace
required sets, change types, or incorrectly couple conditional branches.

Keep validation-bearing siblings at their original schema level and insert the
referenced target as a separate `allOf` child. Preserve any existing sibling
`allOf` children. Do not merge the target's properties or validation keywords.
In particular, do not use `allOf: [target, siblings]`: sibling
`unevaluatedProperties` needs the annotations produced by the adjacent reference
(now the adjacent `allOf`). `additionalProperties` has different local scope.

Annotation-only siblings retain the established display overlay behavior so a
referenced binary form field with a local description remains a file field.
Boolean reference targets retain the earlier boolean-schema implementation.
This change is scoped to OpenAPI 3.1 Schema Objects, not other Reference Objects
or the legacy unmarked reference helper.

Composed form roots and fields cannot currently be represented faithfully by the
flat form editor. Reject these explicitly rather than creating an empty form or
turning a composed file schema into a text field. This is a support boundary,
not completed composed-form support.

## Evidence and verification

Before the fix, a referenced `minLength: 5` plus sibling `minLength: 1` imported as
`minLength: 1`, permitting a one-character value the original schema rejected.
Regression tests compare original, imported and JSON-persisted schemas with an
independent JSON Schema 2020 validator. Ajv 8.20.0 was already a locked transitive
development dependency and is now explicitly pinned for these tests. It is not
added to the application runtime.

Cases cover conflicting types, both required sets, closed properties,
`additionalProperties`, `unevaluatedProperties`, existing `allOf`, isolated
conditional branches, boolean targets, portable export/reimport, file-field
annotations and explicit composed-form rejection. Malformed sibling `allOf`
must not become valid merely because a reference was inserted.

This is not a general reference-elimination algorithm, full dialect converter,
or whole-document validator. Existing cycle, dynamic-reference and embedded
resource-scope limitations remain. OpenAPI 3.0 export still rejects unsupported
3.1 keywords rather than dropping them. Depth/node limits and the prohibition
on automatically fetching external references remain unchanged.

References:

- https://json-schema.org/draft/2020-12/json-schema-core#section-8.2.3.1
- https://json-schema.org/draft/2020-12/json-schema-core#section-10.2.1.1
- https://spec.openapis.org/oas/v3.1.0.html#schema-object
