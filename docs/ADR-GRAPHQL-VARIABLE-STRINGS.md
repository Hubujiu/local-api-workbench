# Bounded GraphQL variables string placeholders

Based on PR171 head `41d542866a6dfced42f548ff73dd00a7b7071d41`.
This independently implemented subset uses the public [Postman GraphQL HTTP
variable syntax](https://learning.postman.com/docs/use/send-requests/protocols/graphql/graphql-http).
It is not general Postman textual substitution or GraphQL editor-mode fidelity.
No original application, new dependency, account or license acceptance is needed.

## Contract

Only complete string leaves in `graphql.variables` may contain `{{name}}`.
Nested objects/arrays are supported. Names match
`[A-Za-z_][A-Za-z0-9_.-]{0,199}`. Query, operationName and object keys remain
static. Partial strings, bare JSON substitutions and duplicate members in a
**templated** payload reject. Static legacy imports retain their existing
lexeme-preserving behavior, including static duplicate members.

The explicit request marker is `graphqlVariableTemplate: {version: 1}`.
No ordinary JSON request acquires the policy merely by resembling GraphQL.
The marker and body are validated together on normalization and execution;
malformed or stale markers are not silently removed. Serialized variables are
scanned at original JSON token positions, including Unicode-escaped tokens,
so large static number lexemes and whitespace are not silently rewritten.

Variable lookup uses the existing effective execution scope, after BEFORE
processing. The resolved value must be an own data property containing a
well-formed string. Missing, inherited, accessor, numeric, object and null
values reject before main-request transport. The replacement is JSON-encoded,
not interpolated into raw JSON. A replacement containing `{{text}}` is literal
and never expanded a second time. Existing pre-script side effects, if any,
are not rolled back by later rejection; the tests' zero-send cases have no scripts.

## Limits and lifecycle

The new dynamic subset is restricted to 1 MiB input/output, 100,000 JSON nodes,
depth 64, and 100 placeholder occurrences combined with active dynamic parameter
rows. Each resolved value must fit the existing 64 KiB serialized dynamic-value
limit. Rendering and subsequent dynamic processing share the existing five-second
wall-clock allowance; no limit is raised. Ordinary static GraphQL retains its
existing 8 MiB limit. Concurrent bodyDynamic definitions and script final-body
overrides are rejected for marked requests, rather than mixing grammars.

Stored requests, frozen plan definitions and backups retain the marker. Only
resolved execution copies lose it; direct transport of an unresolved marked
request rejects. Live edits do not change old frozen definitions. Frozen plans
still resolve variable values using their selected runtime environment; they do
not freeze secrets or current environment values.

Native JSON/directory, OpenAPI and cURL definition export reject unresolved
markers, including frozen definitions, instead of silently projecting a dynamic
body as static JSON. Project backup is the preservation path. Static GraphQL
exports are unchanged. This slice adds no native GraphQL editor format.

## Evidence

The pure tests cover escaped tokens, nested leaves, exact static number lexemes,
invalid metadata, ambiguous JSON, typed values, inert getters and bounds.
The workflow tests use fictional data and a loopback HTTP peer for owner and
official MCP SDK stdio execution, environment switching, escaping, zero-send
failures, frozen/live divergence, backup/restore/restart and export refusal.
The prior static GraphQL suite remains applicable: only the two now-supported
complete placeholder rejection cases moved into positive coverage.
