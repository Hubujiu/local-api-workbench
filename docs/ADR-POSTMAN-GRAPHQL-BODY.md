# Postman static GraphQL body import

## Scope and source evidence

The importer previously silently converted a legitimate Postman `body.mode = "graphql"` request to `bodyType = "none"`. At baseline `67a67565d05edf55e07dd6bf38e96a5c39298d9c`, a self-authored collection sent to a real local HTTP server produced `{ "bodyType": "none", "body": "", "wire": { "method": "POST", "body": "", "contentType": null } }`.

This original adapter uses the public [Postman collection v2.1 schema](https://schema.postman.com/collection/json/v2.1.0/draft-07/collection.json) and [Postman runtime body builder](https://raw.githubusercontent.com/postmanlabs/postman-runtime/develop/lib/requester/core-body-builder.js) as format/behavior references. No proprietary implementation is copied and no dependency or license acceptance is added. The upstream builder serializes query/operationName and can insert variables strings verbatim, including invalid JSON. This importer deliberately supports a smaller, validated static JSON contract, rather than reproducing malformed or dynamic wire payloads.

## Contract

- An enabled GraphQL body requires a plain `graphql` object containing a string `query`, optional string `operationName`, and optional `variables`. Unknown GraphQL fields fail explicitly. Empty query/operationName strings are retained; GraphQL syntax itself is the destination server's responsibility.
- Variables may be a JSON object, null, a valid serialized JSON object/null, omitted, or exactly the empty string. Omitted/empty string omit the variables member; null remains explicit null. Arrays/scalars at the variables root, whitespace-only strings, malformed JSON, undefined, nonfinite numbers and custom/non-JSON values reject. Nested JSON arrays/scalars are supported.
- Serialized variables preserve their original validated JSON text, including number lexemes, whitespace, duplicate keys and order. This avoids silently rounding serialized integers before sending. Direct JavaScript objects already have JavaScript number precision; no arbitrary-precision claim is made.
- Dynamic `{{` sequences reject in query, operationName, variables keys and nested strings. Decoded string tokens are checked, including unicode-escaped templates in overwritten duplicate-key values. The existing request runner interpolates serialized body text; allowing templates here could change payload semantics or break JSON quoting. No template/editor evaluation or GraphQL editor-mode roundtrip is claimed.
- Inputs are bounded to 8 MiB per string/output, depth 64 and 100,000 JSON nodes. Before serializing object variables, traversal counts cumulative JSON UTF-8 bytes, including escaping, keys, separators and delimiters. Accessors, proxies, cycles and serialization hooks reject without invoking them. No memory-pressure test is used.
- `body.disabled: true` yields canonical `none` with empty body without parsing GraphQL contents. A nonboolean disabled flag rejects.
- Enabled bodies become ordinary canonical JSON HTTP requests. Existing enabled Content-Type values, including an empty string, remain untouched. Missing/disabled Content-Type uses the existing JSON default. No new URL normalization or protocol behavior is added.
- Invalid mixed collections fail before owner import persistence, rather than partially saving the valid prefix. Errors do not include input values or credentials.

## Validation and boundaries

`postman-graphql-body.test.mjs` exercises pure import, inert-data rejection and real HTTP header/body behavior. `postman-graphql-workflow.test.mjs` exercises owner import, persistence/restart, frozen case/plan CLI, backup restore/project isolation, OpenAPI and cURL semantic roundtrips, disabled bodies and byte-identical disk state after invalid mixed imports. `postman-graphql-sdk.test.mjs` uses the official SDK over HTTP and a real stdio child process for execution, frozen plans, saved evidence/reconnect, existing unauthorized-project denial and read-only grants without extra traffic.

All fixtures are static, ordinary localhost HTTP, without scripts, VM, XML, native SQLite or database work. Exports preserve HTTP JSON semantics, not the original Postman editor mode. Structured-URL fixes are an independent feature and are not included here. This is one backend slice, not complete Apipost parity or whole-project acceptance.

OpenAPI roundtrip evidence is limited to the tested ordinary JSON numbers and nonempty/default Content-Type. The existing OpenAPI exporter parses body JSON and may round large numeric lexemes or replace an explicitly empty Content-Type; this feature does not fix those separate export limitations. Exact serialized variables preservation applies to import and unchanged canonical body execution, not every export format.

## Common Postman body-mode error paths (same import feature)

The schema's body object has no required `mode`: omitted/null body or an object without mode retains canonical `none`. Present mode must be one of the five schema modes. A present `disabled` must be boolean; `true` suppresses every legal mode, including file and GraphQL, without interpreting inactive payloads. Unknown modes reject even when disabled, rather than silently implying support.

The selected mode alone now chooses form rows: residual `urlencoded: []` cannot shadow active `formdata`, and stale form fields cannot leak into raw/none. Existing raw JSON-language conversion and form-row enabled/type/filename metadata remain unchanged. Multipart imported files retain `requiresFile` and refuse execution until explicitly selected. Active `file` body mode (both `src` and inline `content`) explicitly rejects: binary file-body import is not implemented and no local path is opened or payload guessed.

A real HTTP baseline on `cc444bfd73306410a85afac5c2d50bd7ad9d0f29` sent a disabled raw sentinel and dropped an active multipart field when an empty residual urlencoded array existed. The regression tests use self-authored static input and real HTTP. `postman-body-modes.test.mjs` checks normal/disabled/error modes and file guards; `postman-body-modes-workflow.test.mjs` verifies six active/disabled raw/urlencoded/formdata requests through owner save, frozen plans, restart, backup/restore, exact multipart fields, unchanged disk after mixed invalid imports, and restored file guards before any network request. This does not implement binary file bodies or resolve unrelated XML/scripting CI failures.
