# Response content schemas and automatic Mock

## Contract

OpenAPI Media Type Objects keep `schema`, `example`, and named `examples` as distinct data. A missing example must not be converted to an explicit `{}` response, because explicit examples take precedence over schema generation.

- New imports materialize all supported inline response examples for concrete 100–599 statuses, with JSON media preferred for default ordering. Falsy JSON values and literal text/XML remain distinct. See [managed response examples](ADR-OPENAPI-RESPONSE-EXAMPLES.md) for source bindings and limits.
- Missing examples produce no flat Mock example. `default` and wildcard statuses keep their original response metadata without inventing a concrete 200 example. External example URLs are not fetched.
- Explicit index selection returns that example; without an index, conditional rules precede the first stored example. Otherwise the first concrete 2xx response with a schema is selected in request-definition order. Legacy top-level `schema` is supported; visual/OpenAPI `content[media].schema` is now supported too.
- Within that response, prefer `application/json`, then another JSON subtype or `+json` media with a schema. A non-JSON-only response produces an explicit unsupported error, rather than silently jumping to a later status. False/unsatisfiable schemas remain errors. With no eligible schema at all, the historical 200 `{}` fallback remains.
- Generation uses the same bounded sampler, project model references, field rules, and seed as other sample generation. Generated responses pass the shared final-response validator before transmission. HTTP no-body status semantics still apply.
- Media recognition validates a bounded HTTP header value and token/token base type. It does not implement a complete MIME-parameter parser or Accept negotiation.

## Export boundaries

Flat examples use their explicit Content-Type instead of inventing a parallel `application/json` media entry. Non-JSON text remains literal text. Original named examples remain exclusive with `example`, as required by OpenAPI.

Managed imports now rebuild body examples from the edited cases during export, with source fingerprints preventing conflicting raw-annotation edits. Legacy unbound projects retain original annotation precedence. Arbitrary binary media, per-case delay/header mappings, wildcard-status Mock selection, and an OpenAPI 3.1 exporter are not claimed. Unsupported schema keywords still fail explicitly in the existing 3.0 exporter.

## Verification

Regression cases cover visual response definitions, missing/falsy examples, JSON suffix media, legacy definitions, named-example export, literal text, invalid media keys, and unsupported schemas. A loopback HTTP test checks generated status/media/body with independent Ajv validation. The browser imports a schema-only response, reloads persisted data, selects the Mock URL, and sends the request through the UI.

The response-example dialog also uses a compact name/status/delay row and a shorter headers editor. Browser geometry checks require all its fields to remain inside the content area at the desktop viewport, not behind the footer.

Reference: [OpenAPI 3.1 Media Type Object](https://spec.openapis.org/oas/v3.1.0.html#media-type-object).
