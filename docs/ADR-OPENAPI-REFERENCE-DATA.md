# Resolve references without rewriting example data

## Decision

For documents carrying an OpenAPI/Swagger marker, local-reference traversal now
follows explicit document positions: path items, operations, parameters,
request/response content, headers, named Example Objects, components, callbacks,
links and security schemes. Schema traversal reuses the existing shared
schema-position rules.

Media examples, Example Object values, schema examples/defaults/enums, Swagger
response-example maps and extension values are literal data. A property named
`$ref` inside those payloads must not change what the eventual HTTP request
sends. Conversely, schema properties named `example`, `default`, `value` or
`$ref` are still visited as schema definitions, not guessed from their names.
A named Example Object reference resolves its definition but not its value.

Real external references remain rejected and are never fetched. A literal URL
inside payload data is not a reference fetch request. Input is cloned, cycles
retain an unresolved local reference as before, and expansion has depth and
50,000-node bounds. No partial converted project is saved on failure.

## Limits and evidence

The exported helper retains its previous generic traversal for unmarked objects
for compatibility with its existing callers. This is not a general JSON
Reference engine, a change to every object-reference sibling-composition rule,
or complete Swagger/OpenAPI import support. The OpenAPI
[Reference and Example Object definitions](https://spec.openapis.org/oas/v3.1.0.html)
provide the distinction between reference-bearing definitions and instance data.

Regressions first reproduced corrupted request/response examples and false
external-reference errors. Tests cover typed references, colliding property
names, literal annotations, named examples, Swagger examples, actual HTTP body
bytes interpreted as JSON, no source mutation, and bounded acyclic fan-out.
