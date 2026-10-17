# Development checkpoint — 2026-10-17

This is an unfinished implementation, not a delivery claim.

## Current verified evidence

- `npm run check` passes.
- `npm test`: 30/30 passing, no skips. Local HTTP/TCP/SSE/WebSocket fixtures, real SQLite, filesystem restarts and conflict detection, MCP authorization and plan assertions are covered.
- Raw initial red and current green outputs are in docs/evidence.
- UI smoke script exists but cannot launch Chromium inside the current restricted sandbox (UNIX socket operation denied). Standard escalated execution fails before startup with a read-only-filesystem runtime error. No workaround to security policy attempted.
- Own cloud browser cannot reach the per-command isolated loopback service. The original product was successfully inspected using that browser.
- Desktop wrapper is implemented but has not been packaged or executed. No installer is claimed delivered.

## Remote gate

GitHub connector has repository read/write primitives, but no create-repository primitive. CLI is not authenticated; own cloud browser shows GitHub login. User has been asked to create Hubujiu/local-api-workbench initialized with README and allow the existing connector access. At 11:11 UTC the repository API still returns 404, which may mean nonexistent or inaccessible. Do not claim it exists.

After repository becomes accessible:
1. Read root instructions and branch state.
2. Create/reuse one fixed `develop` branch. Do not make per-task branches. Do not merge main without explicit approval.
3. Publish initial implementation as a draft PR with honest verification limits.
4. Run all fixed CI, inspect UI screenshots, fix failures without weakening tests.
5. Finish all remaining parity gaps and real desktop verification before calling the product complete.

## Important architecture

- Node 24, no required runtime npm dependencies for browser-mode service.
- Vanilla module frontend, original cream/gold layout adapted from observed official screenshots, no copied proprietary assets.
- Loopback-only service with Host/Origin validation, UI session token, no CORS wildcard, CSP.
- JSON project storage with atomic rename, disk lock, optimistic revision checking.
- Network responses bounded, total and idle timeout, cancellation, gzip/br/deflate decode. TLS verification is not disabled.
- Deterministic immutable plan snapshots and SHA256, per-step evidence preserved on extraction failure, expected status assertions, continue-on-failure, maximum 50 records.
- SQLite read-only worker with 2-second timeout and 1000-row limit.
- MCP stdio default no access, explicit project allowlist; write and execution separately opted in on the command line. No persistent access configured for a real Agent.

## Known implementation gaps / review items

- Source needs standard formatting and module decomposition before delivery; do not treat compact first-pass source as final quality.
- UI is not yet browser-verified. Especially verify dialog lifecycle, saving after execution, multi-tab state, project switching during requests, stale revisions, import/export interactions, mobile/narrow view and dark theme.
- API responses are keyed by project/request after a source-level concurrency fix; this still needs real UI verification.
- Native backup restore now makes a new project copy with environments/plans and bounded histories; source is not overwritten. Imported hard-coded local URLs may need environment adjustment.
- Project delete/rename workflows, richer documentation editor and full folder operations need completion.
- Arbitrary JS scripts, OAuth2/Digest, certificate/proxy configuration, MySQL/PostgreSQL, YAML/remote OpenAPI refs and full native Git conflict workflows remain incomplete.
- SSE/WebSocket/TCP bounded capture exists and is fixture-tested; continuous interactive session UX and WebSocket custom headers remain incomplete.
- Multipart file bodies now supported and binary preservation is tested.
- Public product pricing says no functional tiers and all license terms are paid. No activation/payment bypass. Implement free equivalent functionality, exclude license commerce/paid cloud modules. Do not confuse V7/V8 online edition docs with this offline product.

## User communication constraint

Only root works on this project; no Codex tasks, no cloud task delegation, no subagents. No routine progress reports until complete. Contact user only for an unavoidable blocker. Repository creation question is already pending; do not repeat it.

Latest checkpoint: 11:14 UTC. Added local OpenAPI reference resolution, schema samples, full backup restore-as-copy, multi-tab response attribution and visual assertion/extraction editors. Browser gate and repository access remain pending. No commits/PRs published.

12:29 UTC: User confirmed repository creation. Verified private Hubujiu/local-api-workbench, main initial commit 5af2f63913e097efd6fb3325103bd5fd2ee0f6a1, only README.md. Access blocker resolved. Preparing fixed develop branch and initial draft PR; UI/desktop CI not yet run.
