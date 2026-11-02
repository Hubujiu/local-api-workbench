# Source integration audit: update-only Store and explicit restore

## Scope and validation boundary

This integration starts at accepted backend root `e0ba44e275da95435ae0c0d70593d428e5730988`
(tree `2b8f2d65c0fbba527783417465198776cf10fa4c`) and applies only the PR #17 delta
from `82336c421e9702b258228c2cdfd95197c1eb8125` to
`b2ff5ef24362cc45b03931861ecab0f739953990` (feature tree
`c5bf0c46b2b24e3e7bbffee0a043e13689935cf6`). This is **source integration, not a
runtime acceptance claim**. No app, Store, filesystem-corruption fixture, server,
CLI, VM/Worker/Mock/SQL test, build or reference was executed locally. Ordinary
exact-integrated-head CI remains required; feature CI cannot substitute for it.

The only production merge conflict was `Store.readUnlocked`. The authoritative
split-directory check was integrated while retaining the root's native-inheritance,
API-resource-trash, Postman OAuth2 and gRPC history validators on both read paths.
The root cancellation checks, native identity/context checks, API-resource restore
restriction, fingerprint/configuration CAS, latest history merge, database receipts,
commit outcomes, project/registry lock order, publication and import ownership
protocols remain in place. `src/core.mjs`, `src/project-files.mjs`, MCP/CLI modules,
workflow files and dependencies are unchanged from the accepted root. The server
delta only switches the existing owner restore route to the explicit Store API.

## Internal Store contract

- `await store.create(name, directory)` is ordinary explicit creation and retains
  the unresolved-project guard.
- `const copy = await store.restore(rawBackup)` validates the raw backup and calls
  the accepted root's `restoreProject` exactly once. Use the returned copy's ID.
  This new identity is exclusively reserved and can recover a backup beside a
  damaged source without consuming unrelated creation intents.
- `await store.save(copy)` is only for a later update of that persisted identity.
- Never use `save(restoreProject(rawBackup))`, never pass an already transformed
  copy to `restore`, and never ignore `restore`'s actual returned identity.
- To change the initial restored configuration, edit a detached raw backup before
  calling `restore`; invalid input is not published as an intermediate project.
- Pure in-memory `restoreProject` validation/normalization remains a supported
  helper and does not persist anything.

## Fixture classifications

All prior test names/scenarios and their assertions remain. The feature's five
fixture persistence intents are retained: three Socket.IO first-persist calls,
record-ID roundtrip first persistence, and invalid record-ID restore rejection.
The last now scans **all owned fixture paths** for a published transaction instead
of checking an unrelated pre-generated ID. Its old revision/state assertions stay.

The following 60 additional root first-persist sites are migrated, not blanket
`save` replacements. Site lines refer to the accepted source where practical;
inputs/variable names disambiguate repeated fixtures. Every successful migration
uses the actual returned identity and performs only one restore transformation.

| Fixture | Original site | Classification |
| --- | --- | --- |
| `apipost-database-import.test.mjs` | `restored ← JSON.stringify(loaded)` | fresh adjacent persistence |
| `apipost-directory-export.test.mjs` | `restored ← p` | fresh adjacent persistence |
| `apipost-directory-export.test.mjs` | `restored ← before` | fresh adjacent persistence |
| `apipost-export.test.mjs` | `restored ← await store.get(p.id)` | fresh adjacent persistence |
| `apipost-mock-export.test.mjs` | `restored ← before` | fresh adjacent persistence |
| `apipost-mock-media-export.test.mjs` | `restoredConsumer ← disk` | fresh adjacent persistence |
| `apipost-mock-media-export.test.mjs` | `restored ← current` | fresh adjacent persistence |
| `apipost-sample-export.test.mjs` | `restored ← backup` | fresh adjacent persistence |
| `digest-replay.test.mjs` | `restored ← stored` | fresh adjacent persistence |
| `http-extraction-atomic.test.mjs` | `restored ← backup` | fresh adjacent persistence |
| `http-redirect-root-workflow.test.mjs` | `restored ← disk` | fresh adjacent persistence |
| `http-redirect-root-workflow.test.mjs` | `restored ← disk` | fresh adjacent persistence |
| `http-redirect-storage.test.mjs` | `restored ← JSON.parse(JSON.stringify(reopened))` | fresh adjacent persistence |
| `imported-native-flow-source.test.mjs` | `restored ← restarted` | fresh adjacent persistence |
| `imported-native-task-source.test.mjs` | `restored ← restarted` | fresh adjacent persistence |
| `imported-native-task-source.test.mjs` | `restored ← reloaded` | fresh adjacent persistence |
| `mcp-inheritance-roundtrip-sdk.test.mjs` | `restored ← persisted` | fresh adjacent persistence |
| `mcp-project-roundtrip-sdk.test.mjs` | `restored ← executed` | fresh adjacent persistence |
| `native-database-integration.mjs` | `restored ← await app.store.get(project.id)` | fresh adjacent persistence |
| `native-database-scopes.mjs` | `restored ← saved` | fresh adjacent persistence |
| `native-flow-task-isolation.test.mjs` | `restored ← p` | fresh adjacent persistence |
| `native-grpc-metadata.test.mjs` | `restored ← p` | fresh adjacent persistence |
| `native-grpc-tls.test.mjs` | `restored ← p` | fresh adjacent persistence |
| `native-inheritance-flow.test.mjs` | `restored ← p` | fresh adjacent persistence |
| `native-inheritance-form.test.mjs` | `restored ← stored` | fresh adjacent persistence |
| `native-inheritance-store-cancellation.test.mjs` | `copy ← persisted` | fresh adjacent persistence |
| `native-inheritance-workflow.test.mjs` | `copy ← persisted` | fresh adjacent persistence |
| `native-inheritance-workflow.test.mjs` | `restoredCaseProject ← loaded` | fresh adjacent persistence |
| `native-mcp-environments.test.mjs` | `restored ← await app.store.get(p.id)` | fresh adjacent persistence |
| `native-mcp-workflows.test.mjs` | `restored ← p` | fresh adjacent persistence |
| `native-mcp-workflows.test.mjs` | `restored ← await store.get(p.id)` | fresh adjacent persistence |
| `native-mock-export-entrypoints.test.mjs` | `restored ← persisted` | fresh adjacent persistence |
| `native-mock-route.test.mjs` | `copy ← JSON.stringify(saved)` | fresh adjacent persistence |
| `native-mock.test.mjs` | `restored ← JSON.stringify(saved)` | fresh adjacent persistence |
| `native-mongodb-integration.mjs` | `restored ← saved` | fresh adjacent persistence |
| `native-redis-cli-integration.mjs` | `restored ← saved` | fresh adjacent persistence |
| `native-redis-integration.mjs` | `restored ← saved` | fresh adjacent persistence |
| `native-redis-owner-integration.mjs` | `restored ← saved` | fresh adjacent persistence |
| `native-socketio-handshake.test.mjs` | `restored ← p` | fresh adjacent persistence |
| `native-task-plan.test.mjs` | `restored ← JSON.stringify(reloaded)` | fresh adjacent persistence |
| `original-directory-artifacts.test.mjs` | `restored ← structuredClone(loaded)` | fresh adjacent persistence |
| `original-execution-import.test.mjs` | `restored ← structuredClone(saved)` | fresh adjacent persistence |
| `original-mcp-flow-import.test.mjs` | `restored ← JSON.stringify(saved)` | fresh adjacent persistence |
| `original-offline2-import.test.mjs` | `restored ← structuredClone(loaded)` | fresh adjacent persistence |
| `plan-repeat-consumers.test.mjs` | `restored ← current` | fresh adjacent persistence |
| `plan-repeat-consumers.test.mjs` | `restored ← current` | fresh adjacent persistence |
| `postman-graphql-root-workflow.test.mjs` | `restored ← JSON.parse(JSON.stringify(backup))` | fresh adjacent persistence |
| `postman-graphql-root-workflow.test.mjs` | `restored ← JSON.parse(JSON.stringify(disk))` | fresh adjacent persistence |
| `progress-evidence-combined-entrypoints.test.mjs` | `restored ← JSON.parse(JSON.stringify(recovered))` | fresh adjacent persistence |
| `protocol-extraction-atomic.test.mjs` | `copy ← JSON.stringify(backup)` | fresh adjacent persistence |
| `protocol-handshake.test.mjs` | `restored ← p` | fresh adjacent persistence |
| `apipost-export.test.mjs` | near line 72 | fresh persistence separated only by reads/assertions or unrelated setup |
| `aws-query-signature.test.mjs` | near line 648 | fresh persistence separated only by reads/assertions or unrelated setup |
| `native-document-lifecycle.test.mjs` | near line 504 | fresh persistence separated only by reads/assertions or unrelated setup |
| `native-noauth-entrypoints.test.mjs` | near line 377 | fresh persistence separated only by reads/assertions or unrelated setup |
| `native-signing-entrypoints.test.mjs` | near line 234 | fresh persistence separated only by reads/assertions or unrelated setup |
| `native-mongodb-integer-precision.test.mjs` | near line 109 | fresh persistence separated only by exact numeric assertions |
| `original-execution-import.test.mjs` | near line 729 | loop mixed original and fresh restore: only fresh branch persisted once |
| `plan-repeat-workflow.test.mjs` | near line 267 | pre-first-persist mutation: cloned raw backup environment edited before one restore |
| `native-mock-media.test.mjs` | near line 126 | pre-first-persist mutation: JSON-cloned raw backup mock fallback/header edited then validated and restored once |

### Special dataflow and assertions

- `native-mock-media`: JSON-clone the raw saved backup, make both original
  fallback-body and mixed-case Content-Type edits, then restore once at the former
  first-write boundary. The equality assertion now compares the actual returned
  persisted `nativeMock` against the edited raw backup, preserving normalization
  coverage rather than tautologically comparing a clone with its source. All
  original/restored HTTP, serialization, isolation and restart checks remain.
- `plan-repeat-workflow`: clone the raw saved backup, change environment identity
  to `restored`, and then restore once. Frozen evidence/hash/result comparisons and
  owner/SDK/CLI/restart checks are unchanged; no baseline copy is published first.
- `original-execution-import`: the mixed `[original, restored]` loop initializes
  only its second item through explicit restore. Remove only the old conditional
  first save; both real executions and provenance assertions remain.
- `native-document-lifecycle`, `native-mongodb-integer-precision`, native signing
  and noauth: assertions between old transform/save now inspect the actual returned
  persisted copy; trash, identity, numeric precision, durable run and auth assertions
  are unchanged.
- `aws-query-signature`: the original plan snapshot is still captured and compared;
  the existing freshStore alias owns the explicit restore.
- `apipost-export`: unrelated setup and all assertions remain; only fresh-copy
  persistence moves to its explicit creation call.

### Deliberately retained update and pure-transform sites

The three later `native-mock-route` calls to `save(copy)` remain ordinary updates.
The `apipost-export` loop's `reopened.save(copy)` remains an update after `get(id)`.
All other source owner/MCP/CLI saves continue to update an existing loaded identity;
CLI execution reads an existing project and appends evidence, not a backup import.

Pure `restoreProject` sites (including negative validation and getter-safety cases)
are not persisted and remain unchanged in: `core`, `apipost-auth-import`,
`apipost-export`'s export-only backup, `grpc-plan`, `grpc-plan-scripts-workflow`,
`wire-plan-scripts-workflow`, `http-redirect-definition-guards`,
`imported-native-flow-source`, `imported-native-task-source`, `model-folders`,
`native-document-lifecycle`, `native-inheritance-workflow`, `native-mcp-workflows`,
`native-ssh-policy`, `original-directory-artifacts`, `original-execution-import`'s
three provenance/auth/body assertions, `original-offline2-import`'s second restore,
`plan-repeat-consumers`, `plan-step-identities-workflow`, `postman-oauth2-owner`,
`postman-oauth2-root`, and `query-serialization`.

## Static conservation proof

A parser-only Babel AST comparison across all 669 pre-existing test `.mjs` files
finds the same ordered 2,862 test declaration names/templates and the same 24,753
assertion calls. These are **source declaration counts**, not executed/expanded
case counts. Only three existing assertion expressions change: the actual restored
Mock comparison described above, the invalid-record call to the new explicit API,
and that case's all-fixture journal-absence check. No assertion is deleted.

Both new regression files are preserved from the feature: 11 test declarations
expand to the feature's 24 scenarios (21 real-filesystem plus owner stale import,
direct MCP stale sync, and owner backup restore). Direct MCP is dispatcher-level,
not an official SDK claim. Existing official SDK and CLI restore/restart workflows
are retained through the fixture setup migrations above.

Static syntax parsing, the complete repository formatter check and diff whitespace
checks are the only validation performed here. The accepted root's previous CI and
the feature's separate CI do not establish this integrated tree's runtime result.
