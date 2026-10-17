# Local API Workbench — frozen delivery plan

## Evidence and scope (2026-10-17)
Observed official product site, pricing, help/basics, help/mcp and help/executions via cloud browser. Product screenshot: cream title/sidebars, thin vertical navigation, tree sidebar, request tabs, design/debug/cases/load/mock, request parameters and split response panel. Implement independently with original branding; do not redistribute Apipost binaries/assets.

Important discrepancy: pricing explicitly says there are no separate functional editions, all licenses are paid; the homepage's “free start” points to pricing. Interpret “exclude paid modules” as exclude billing/license/activation, online collaboration and paid AI services, not exclude the API client itself. Do not bypass activation. Exact hidden behavior cannot be certified from a marketing screenshot. Track unsupported capabilities honestly.

Sources:
- https://offline.apipost.net/help/
- https://offline.apipost.net/help/executions/
- https://offline.apipost.net/help/mcp/
- https://offline.apipost.net/pricing/
- https://github.com/usebruno/bruno (MIT; reference offline Git-friendly architecture, no copied source)
- https://github.com/hoppscotch/hoppscotch (MIT; reference separation of collections/environments/runtime, no copied source)

## Fixed acceptance plan
1. Project CRUD, stable request IDs, folders, search, duplicate, soft delete/restore, restart persistence and atomic saves.
2. HTTP requests: method, URL/query/path/environment substitution, headers, auth, cookies, body types, timeout, bounded response, abort, actual response metadata.
3. API design/schema/description, examples, reusable dictionary, standalone docs, native JSON/OpenAPI/Postman/cURL import and export with validation.
4. Environments with selected scope, pre/post operations, assertions and variable extraction; failure details visible.
5. Snapshot execution plans: repeat APIs with independent overrides; serial deterministic execution; continue on failure; preserve plan hash and complete per-step evidence; last 50 runs; expected error status supported explicitly.
6. Test cases and bounded load test, report timing/status/assertions; local mock examples.
7. MCP stdio: project allowlist, default no write/no execution; tools list/read/import/plan/run, explicit grants; no remote cloud dependency.
8. Theme/layout, keyboard navigation, unsaved changes, modal dismissal, error/loading/empty states.
9. Git-friendly local files, explicit backups/import; never auto-push credentials or runtime private data.
10. Security: bind loopback, reject cross-origin/invalid Host, require UI session token on mutation, static path confinement, no shell execution of imports, bounded requests/responses, no automatic external requests on startup.

Tests are committed before implementing relevant behavior. Local deterministic fixture server only; never load test public services. CI repeats same commands. No paid SDK, telemetry, CDN, or cloud account needed at runtime.

## Delivery constraints
Work only in own environment, no delegation. All product updates by PR using one persistent development branch. No main merge without approval. GitHub connector has no repository-creation action; cloud browser currently logged out and gh unauthenticated. Continue local implementation; remote creation remains a delivery blocker, not a reason to stop coding.
