# OpenAPI TRACE admission: reject, do not silently drop

## Contract

The HTTP runtime supports GET, POST, PUT, PATCH, DELETE, HEAD and OPTIONS,
not TRACE. [OpenAPI 3.0.3 Path Item](https://spec.openapis.org/oas/v3.0.3.html#path-item-object)
and [OpenAPI 3.1.0 Path Item](https://spec.openapis.org/oas/v3.1.0.html#path-item-object)
define TRACE. Previously both the core importer and MCP operation enumeration
selected the same seven methods: a valid mixed GET + TRACE source could report
success while omitting the TRACE request. Comparing their row counts did not
detect this loss.

After local references resolve, `supportedOpenAPIPathItems` rejects the entire
import when an actual request Path Item owns `trace`. This happens before row
creation, component merging or synchronization. Presence, not truthiness, is
checked; malformed empty/null/false TRACE payloads cannot bypass admission.
Direct Swagger input containing `trace` is also explicitly rejected, but TRACE
is **not** claimed as a valid Swagger 2.0 operation. This is not a general source
schema validator or a policy for arbitrary unknown method names.

The same admission is used by direct `importDocument` / `importIntoProject`,
owner project import, and `localapi_sync_openapi` over HTTP and stdio. Mixed
documents fail all-or-nothing, including all four MCP cover modes. On these
owner/MCP entrypoints rejection must leave request identities, components,
project contents, revisions and saved project bytes unchanged. Source input is
not mutated. Other root-only task/activity import wrappers may intentionally
persist a failed activity receipt; this contract does not promise that their
activity metadata stays byte-identical.

## Literal and reference boundaries

Only `/`-prefixed Paths Object entries produce request rows. Empty Path Items
remain allowed. Path-level summary, description, servers, parameters and `x-*`
metadata are not methods. Paths Object `x-*` values, including null and objects
with get/trace/$ref-shaped data, remain literal and do not produce requests.
The reference context change is confined to document `paths`; it does not
change reusable `components.pathItems`, callbacks or webhooks. In particular,
`components.pathItems['x-Shared']` still resolves when a real path refers to it,
and a referred TRACE operation is rejected. Unreferenced reusable TRACE entries
are not a request row and are not rejected by this admission rule.

There is no TRACE execution, no broader protocol expansion and no claim that
all OpenAPI features or backend modules are now complete.

## Evidence and acceptance

Base: develop `88f70bb515c48b93536b28b7fe3ec780f2e150f3`.

- `tests/openapi-operation-admission.test.mjs`: pure admission/context checks.
- `tests/openapi-trace-workflow.test.mjs`: direct/core sync atomicity plus real
  owner and official SDK HTTP/stdio rejection, exact saved-byte checks, positive
  literal/reference imports and restart persistence.
- Existing reference/import/MCP suites remain necessary regression evidence.

Only the pure helper suite and static checks are run locally for this change.
The application/SDK workflow file is authored for CI and is **not locally
executed**. Delivery requires its actual passing CI evidence on the feature
and subsequently on the combined root; a draft PR is not that evidence. No
application, VM, XML, database, original GUI or pressure execution is required
by this local validation step. Runtime budgets and dependencies are unchanged.
