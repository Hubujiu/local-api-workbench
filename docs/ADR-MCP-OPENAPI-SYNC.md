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
