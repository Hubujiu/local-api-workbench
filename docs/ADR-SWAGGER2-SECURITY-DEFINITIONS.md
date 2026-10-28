# Swagger 2 security-definition migration

## Decision and scope

Owner Swagger 2.0 project import now migrates the source `securityDefinitions`
registry to `openapiComponents.securitySchemes`. This is a new bounded feature:
prior Swagger body/media support did not promise security migration. Previously
the importer retained security requirement names but omitted their definitions,
so an OpenAPI 3 export could contain dangling scheme names.

- `basic` becomes OpenAPI `http` / `basic`.
- Header/query `apiKey` keeps its name and location; cookie keys are not Swagger 2.
- OAuth `implicit` and `password` retain their names, `application` becomes
  `clientCredentials`, and `accessCode` becomes `authorizationCode`. Applicable
  URL references and scope descriptions move into the corresponding `flows`
  entry. Relative URLs remain relative; none are fetched.
- Scheme `description` and JSON `x-*` fields are preserved. Extension `$ref`
  values remain literal data, including external-looking strings.

This imports definitions, not credentials or an executable authentication policy.
Every imported request still has `auth: { type: "none" }`; no username, password,
API key, OAuth token, or OAuth session is inferred. Users may separately configure
runtime authentication. An effective `security: []` disables shared-auth
inheritance, including after OpenAPI reimport. OR alternatives, AND entries,
scopes, empty requirements and anonymous `{}` alternatives are not collapsed.
As in existing import, effective root requirements are recorded per operation;
the root-versus-operation lexical placement is not reconstructed on export.

## Validation and atomicity

The existing context-aware local-reference resolver runs before conversion.
Resolved security aliases are migrated; external, dangling, or remaining cyclic
references fail before any project mutation. The converter does not introduce a
second reference resolver or rewrite literal extension data.

Scheme names must fit OpenAPI 3's `[a-zA-Z0-9._-]+` component-key grammar;
prototype-sensitive names and unsupported names fail rather than being renamed.
Registries/schemes/requirements must have the required object/array shape.
Unknown non-extension scheme fields, unsupported scheme types/flows, invalid
API-key names, missing/inapplicable OAuth URLs, and malformed scope maps fail
closed. Description/scope descriptions must be strings; extension values must
be finite JSON within the existing 50-depth / 50,000-node scale.

Every root and owned operation requirement is checked against the **source**
registry, not a coincidental target project scheme. Non-OAuth schemes require
empty scope arrays; OAuth scope entries must be strings declared by that source
scheme. A hybrid `components`/`openapiComponents` container and any supplied
`securitySchemes` registry must be objects; a conflicting same-source definition
is rejected even in sync mode. Such a nonstandard hybrid registry may only repeat
converted source definitions, not introduce additional scheme names or old
Swagger reference aliases. Other component categories are left intact.

Conversion and component preflight finish before request insertion. Normal
import uses the existing same-name conflict path; equivalent converted security
definitions compare structurally, not by object key order. Other component
categories retain their existing merge rules and are not overwritten wholesale.
Explicit `importIntoProject(..., { sync: true })` retains the existing update
contract: definitions may be updated and matched request IDs are retained, but
source validation still runs. No Swagger MCP synchronization API is added.

## Evidence and limits

`tests/swagger2-security.test.mjs` imports only the pure converter and Node
built-ins. `tests/swagger2-security-workflow.test.mjs` covers owner import/save,
restart, OpenAPI export/fresh reimport, native backup restore, exact definitions
and requirement semantics, explicit fictional Basic/header/query APIKey loopback
execution, and public-request inheritance isolation. Invalid mixed batches check
unchanged input, in-memory project, stored files and revision; same-name target
collisions, reference failures, malformed hybrid registries, reordered equality,
and explicit sync behavior are covered. Application workflows run in ordinary CI,
not as local application/VM/native-database execution.

This is not complete Swagger-to-OpenAPI migration, credential import, OAuth grant
execution, validation of arbitrary existing OpenAPI 3 security registries, or
an expansion of native migration / original runtime / licensing scope.

Primary specifications:
[Swagger 2 Security Definitions and Security Schemes](https://spec.openapis.org/oas/v2.0.html#security-definitions-object),
[Swagger 2 Security Requirements](https://spec.openapis.org/oas/v2.0.html#security-requirement-object),
[OpenAPI 3 Components](https://spec.openapis.org/oas/v3.0.3.html#components-object),
[OpenAPI 3 Security Schemes and OAuth Flows](https://spec.openapis.org/oas/v3.0.3.html#security-scheme-object),
and [OpenAPI 3 Security Requirements](https://spec.openapis.org/oas/v3.0.3.html#security-requirement-object).
