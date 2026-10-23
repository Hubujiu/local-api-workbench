# Static SDK URL definition projection to OpenAPI

OpenAPI export now accepts a bounded static SDK URL definition rather than rejecting every SDK-mode request. This exports logical parameter values, not exact raw URI bytes, script behavior or execution evidence.

The exporter checks effective project/folder/request pre-request scripts and operations before rendering. It never runs scripts, dynamic providers, database operations or network requests. Existing inheritance opt-out and frozen shared-script snapshots retain their meaning. Any pre-request processing, persisted SDK runtime state, unresolved URL placeholders or unsupported Path bindings remain unsupported. Unresolved active dynamic providers also reject.

The existing reviewed SDK URL renderer supplies the URL with raw-origin and table-origin encoding rules. The existing OpenAPI query parser then decodes logical values and rejects duplicate names, invalid encoding, nameless parameters, bare query flags and decoded template literals. Explicit empty-value policy remains checked by the exporter. Query-table descriptions, required flags, schemas and empty-value metadata are retained; inactive members are not exported. Source requests and project state are unchanged.

Post-request assertions and transport-specific behavior are not represented by OpenAPI. Service-relative URLs must start with a single slash; ambiguous bare relative paths reject rather than producing invalid OpenAPI path keys. Their base URL remains an external service binding. This is not full SDK URL or script interoperability. Use project backups for those definitions, and cURL or actual-request evidence where appropriate.

Tests cover metadata preservation, input immutability, rejection before provider execution, effective inherited-script opt-out, import/export roundtrip and real loopback HTTP comparison of decoded query values. Browser coverage exports the same literal request in string and SDK modes and compares the downloaded OpenAPI parameters. Tests do not contact original or third-party API servers.

## Named static Path definitions

Whole path segments written as `{name}` or `:name` may be exported as OpenAPI named path parameters, never as a concrete example baked into the URL. Names must be unique, bounded identifiers and match active Path rows exactly. Each example is nonempty unreserved ASCII text; dynamic bindings, reserved characters, duplicate or unused bindings, repeated placeholders and encoded brace literals remain unsupported. Description/schema/example metadata is retained and Path parameters remain required. The SDK renderer runs with an empty variable table solely for definition projection, not for execution. Real HTTP roundtrip and browser-download assertions cover the resulting path and query values.
