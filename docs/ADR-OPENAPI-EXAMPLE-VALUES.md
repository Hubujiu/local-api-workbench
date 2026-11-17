# Preserve OpenAPI JSON examples and cookie parameters

The importer must not replace explicit `false`, `0`, empty-string, or `null` JSON
examples with `{}`. It now checks field presence, both for request bodies and
response examples. Without a direct example, it selects the first named example
with an inline `value`; external example URLs are never downloaded. The original
operation metadata remains available. Missing examples still use the existing
empty-object fallback; this does not add general schema-driven generation.

Cookie parameters are imported into the existing cookie editor/runtime fields,
including required, schema, description and example/default values. Complex
parameter serialization remains outside this change. Tests cover exact scalar
values and actual loopback HTTP transmission of a false JSON body and cookie.

Primary reference: [OpenAPI 3.1 Media Type Object](https://spec.openapis.org/oas/v3.1.0.html#media-type-object)
and [Parameter Object](https://spec.openapis.org/oas/v3.1.0.html#parameter-object).
This is standards interoperability, not original-client runtime equivalence.
