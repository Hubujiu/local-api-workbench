# Independent Postman Collection v2.1 definition export

## Source, destination and explicit contract

Source is a selected canonical Workbench project snapshot, not a remembered original Postman file. Destination is one Postman Collection v2.1 JSON definition. This does not claim original application parity, full project round trip, independent replay, or a complete Postman exporter.

Only existing owner POST `export-preview` / `export-selection` and MCP `preview_project_export` / `export_project_selection` accept the new explicit format `postman-collection-v2.1`. Existing owner authentication, MCP read/project scopes, dependency confirmation, configuration revision, content digest, 4 MiB artifact and 8 MiB MCP frame limits remain. GET project export and ordinary MCP export_project formats are unchanged. There is no fallback to full backup.

The implementation is independent from cURL/code-example literal-body preparation and empty multipart or empty JSON code exports. No PR128/129 integration, source path changes or ADR copying is included.

## Positive subset

- HTTP GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS, literal HTTP(S) URL without colon-leading path segments (URL templates are rejected), folder hierarchy including selected empty folders, names and descriptions.
- Preserve saved request sequence and folder order. If nesting would reorder the flat saved request sequence, reject rather than silently reorder. Root requests and folder requests cannot always be interleaved in a Collection tree.
- Unique ordinary header names, values and disabled state; no framing/connection-control headers. Literal Authorization/Cookie headers may contain saved credentials.
- No body, or raw text with an explicit enabled non-template Content-Type. Raw is emitted as mode raw with text language and its existing Content-Type; content is not parsed, reformatted, or inferred as JSON. Empty raw remains raw. JSON bodyType, including empty JSON, is outside this first slice.
- No-auth is emitted explicitly; no acquisition, interpolation, script execution, remote request or local file read occurs during export.

Unsupported or unknown behavior rejects the entire artifact: configured inheritance/shared settings, authentication objects, scripts/tasks, dynamic fields and builtins, query/path/cookie tables, service bindings, schemas/assertions/extractions/examples/mock definitions, protocol resources, custom TLS/proxy/timeout, multipart/binary/JSON body modes, ambiguous URLs/header duplicates, unrecognized request/project fields and unsupported selected resources. Default inactive canonical fields are accepted; inherit booleans alone do not introduce shared behavior when configuration is empty.

## Credentials and omitted configuration

This is NOT a redacted sharing document. Selected URL, header and raw-body strings can contain saved credentials. Export returns those exact strings; preview omits the document and warns about credential exposure without echoing values.

Environment/global variable VALUES are never automatically copied into Collection variables or substituted into request strings. Ordinary placeholders in header values/raw bodies remain literal; all URL templates are rejected. Explicit environment/globals selection as the export target rejects. For all/HTTP selections, the dependency graph may include environments/global configuration for validation and confirmation. `omittedConfiguration.environments` identifies omitted environment IDs, `globalVariables` indicates omitted nonempty global values, and `independentlyReplayable` is always false. The preview explicitly distinguishes confirmed graph dependencies from serialized Collection content. It does not promise an environment exporter or silently supply a default environment; the recipient must separately provide required variable values.

Plans, execution history, load receipts, protocol evidence, request history and trash are omitted by the existing definition selection projection, never copied from a backup. Configured unsupported resources are not silently serialized or discarded as successful conversion.

## Verification and provenance

Only ajv-draft-04 1.0.0 is added as a development/test dependency. No production dependency or execution budget is added. SDK documentation: https://learning.postman.com/docs/reference/developer-resources/collection-sdk .

The test schema is assembled from the unchanged parsed JSON/JSON5 source root and 23 named definitions at postmanlabs/schemas commit `c5fa20c6210207d09b06a23d700f9228c31ad703`, `schemas/draft-04/v2.1.0/collection.json` and `schemas/draft-04/v2.1.0/collection/*.json`. Assembly adds only the root `definitions` map, with file basenames as keys; JSON5 syntax is serialized as ordinary JSON. The source Apache-2.0 license is retained alongside the fixture. This is offline schema validation, not execution of original/vendor GUI binaries.

CI tests validate positive output using the official schema and compare owner and MCP selected exports, import the result into a fresh project, and execute synthetic requests on loopback. They cover externally supplied variable values, nonredacted literal credentials, source isolation, frozen requests across backup/restore/restart, stale confirmation, safe previews, accessors/proxies, unsupported policy and zero execution during export. This establishes the bounded definition workflow, not full Postman Runtime defaults or complete interoperability.


## Isolated SDK oracle, not a CI dependency

Official postman-collection 5.3.1 was tested in a separate temporary installation with install scripts disabled. Its dependency tree introduced two high audit entries (old @faker-js/faker and the affected SDK) plus a moderate uuid entry. Therefore the SDK and those dependencies are NOT included in this project package/lockfile or normal CI. No audit threshold was relaxed and no incompatible dependency override was used.

The optional `scripts/verify-postman-definition-sdk.mjs` accepts only an explicit absolute package-directory argument, checks package name/version, and exercises synthetic definition construction/serialization without requests or dynamic-variable evaluation. Example after independently installing the official package in an isolated scratch directory: `node scripts/verify-postman-definition-sdk.mjs /absolute/scratch/node_modules/postman-collection`. Package name/version checks are not cryptographic trust checks; never point it at untrusted code. This oracle is separate local evidence, not a permanently enforced CI gate and not a reason to ignore the dependency findings.


## Colon path round-trip correction

Review reproduced a real semantic defect: a literal `/:id.json` in a canonical URL was exported, then the Postman importer interpreted it as a path variable rather than a literal path. This changes the request target. The exporter now rejects every colon-leading path segment before returning a document, including segments in the unnormalized raw URL. It also rejects all URL templates: without resolving values, this slice cannot prove their eventual path/authority shape or cross-tool interpretation. This is a deliberate compatibility restriction, not a fixture adjustment. Header/raw-body placeholders remain supported. Literal encoded colon `%3A` is separately wire-tested and not treated as a path variable.

The regression retains the old emitted shape as a synthetic counterexample and observes differing loopback targets after import; it then verifies the new exporter refuses that source without sending anything. Positive source and reimported requests now use a static URL and an explicit raw-body variable, preserving the supported variable workflow without claiming URL-template support.
