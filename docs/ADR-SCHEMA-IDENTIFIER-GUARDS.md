# Typed identifier guards in the visual Schema editor

Removing a property must not silently discard an actual nested `$id`, `$anchor`
or `$dynamicAnchor`: named or resource-scoped references can depend on those
identifiers even when no local JSON Pointer targets the property.

The previous serialized-text search also rejected ordinary examples, defaults,
enum/const values, extension payloads and properties named `$id`. Those positions
are data, not declarations of a Schema identifier.

Use the same bounded, typed Schema traversal as the existing reference guard.
Check identifier keys only at Schema positions inside the node being removed.
Keep the local-reference guard, node/depth limits, atomic cloned edits and the
requirement to handle real identifiers through explicit JSON editing. This does
not implement automatic anchor rewrites or full URI/resource resolution.

Red-first regressions cover annotation payloads and identifier-shaped field names.
Nested declarations across maps, compositions, tuples and conditional-schema
positions remain protected. Browser coverage checks the visible refusal for an
actual anchor, successful literal-data removal, saved state and retained siblings.
