# Bounded OpenAPI synchronization over MCP

`localapi_sync_openapi` now accepts an OpenAPI 3.0/3.1 JSON object or JSON string,
optional existing directory path `folder`, `coverMode`, and `apiScripts` mappings.
It continues to require a project write grant and never executes imported scripts
at import time. Non-OpenAPI formats remain available through their separate import
interfaces, not this MCP tool. Remote references are not fetched.

The default `url_and_folder` matches active requests by method, full imported URL,
and resulting directory. This replaces the previous operationId-first matching:
renaming an operationId no longer duplicates an unchanged method/URL/directory,
but moving a URL creates a new request unless another explicit mode matches it.
`url` matches method and URL across directories; `ignore` skips those matches;
`both` always adds a copy. Overwrites retain the first matching request's ID.
Existing duplicates are not silently removed. A target directory is identified by
our existing path model, not the original application's opaque directory IDs.
Imported tags remain subdirectories below the selected target. Components continue
to merge by component category/name, even when duplicate APIs are skipped.

`apiScripts` entries use `method`, the original OpenAPI path in `url`, and optional
`beforeScript` / `afterScript`. Mapping resolves against document operations,
including local path-item references. Unknown operations, duplicate mappings,
invalid field types and oversized scripts fail the entire import. Conversion and
component updates occur on a detached project draft before any mutation. Script
execution later uses the existing sandbox and budgets; import does not validate
JavaScript syntax or guarantee runtime success.

Deliberately incomplete: `clear` is rejected, not implemented as a hidden permanent
wipe. Host/base-path switches are not exposed; existing server URL import semantics
remain. There is no claim of full original wire compatibility or original native
storage support. Existing saved plans remain independent snapshots, not live links
that silently update when an API is synchronized.

## Bounded YAML text (2026-10-29, working implementation)

Canonical and native MCP sync now accept YAML text as well as existing JSON
objects/text. This is a new finite capability, not a correction of the former
JSON-only contract. A shared parser reuses the owner's JSON-first / YAML-fallback
semantics (`yaml` 2.9.1, already installed), `maxAliasCount: 100`, and
`uniqueKeys: true`. JSON strings remain strings, not recursively decoded YAML.
Malformed YAML, duplicate YAML mapping keys and multiple documents reject.
The decoded root must still be an OpenAPI 3.0/3.1 object; Swagger, Postman, cURL,
scalars and arrays are not admitted by MCP. Owner cURL routing remains separate.

Text parsing has an explicit 12 MiB UTF-8 ceiling matching the existing HTTP
request/stdio-frame ceiling. Envelope overhead can make a smaller document exceed
the transport limit; no frame/body limit is raised. Existing local-reference
expansion node/depth limits, remote-reference rejection, sync draft atomicity,
cover modes, script mappings and authorization remain unchanged. This is not an
arbitrary YAML executor or a new resource loader. The existing JSON parser's
handling of duplicate JSON keys is unchanged; uniqueKeys is the YAML policy.

This branch also carries the narrow TRACE admission prerequisite from existing
commit `801e66bace886d68c7f7a9dcea12047d41362364`: shared Path Item admission,
owner/sync call sites, literal Paths Object extension context and its pure tests.
It does not import the integration branch or any unrelated feature.

Local verification is limited to the isolated parser/admission pure tests and
syntax/format checks. Application/SDK/backup/restart workflows await ordinary
CI on the exact saved commit; their presence is not a claim of local acceptance.

Review found that existing reference resolution skips literal example/extension
subtrees. It therefore did not bound every parsed YAML graph: a component example
could contain a cyclic alias. The shared text parser now rejects cycles before
sync can publish its draft, and visits the entire decoded graph with a 50,000-node
and depth-50 ceiling, including literal subtrees. Reused acyclic aliases remain
allowed; each occurrence counts toward the bound. This is an explicit additional
owner text-input admission restriction too, not a claim that old owner parsing
already enforced these limits. Existing reference expansion limits still apply
separately. No VM or application was run to establish this static finding.
