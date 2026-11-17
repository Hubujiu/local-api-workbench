# Bounded Postman inline event import

## Evidence and scope

Reviewed 2026-10-28 against Collection v2.1.0 (draft-07), the published Collection SDK 4.0.2 documentation and current official SDK/runtime/sandbox source. These upstream `develop` links are moving references, not a claim of a pinned runtime compatibility version:

- https://schema.postman.com/collection/json/v2.1.0/draft-07/collection.json (`event`, `script`, `description`).
- https://www.postmanlabs.com/postman-collection/Event.html and https://www.postmanlabs.com/postman-collection/Script.html .
- https://github.com/postmanlabs/postman-collection/blob/develop/lib/collection/event-list.js (`listenersOwn` excludes disabled events; inherited listeners retain parent-first order).
- https://github.com/postmanlabs/postman-collection/blob/develop/lib/collection/script.js (`src` takes precedence over `exec`; `type` is descriptive, not a dispatch enum).
- https://github.com/postmanlabs/postman-runtime/blob/develop/lib/runner/extensions/event.command.js (sequential event dispatch).
- https://github.com/postmanlabs/postman-sandbox/blob/develop/lib/sandbox/execute.js (executes `script.toSource()` as JavaScript without MIME-based dispatch).

At baseline `88f70bb515c48b93536b28b7fe3ec780f2e150f3`, the importer selected only `listen` and flattened `exec`. A schema-valid disabled collection/folder/request event therefore entered the active request script. With both `src` and `exec`, it incorrectly selected inline code despite the SDK's source precedence. Non-text array elements could become source through implicit string coercion. These are source-inspection findings; no local VM or HTTP reproduction was performed for this task.

## Contract

- Optional event lists are plain, dense arrays. Events support `prerequest` and `test`; `disabled` must be a boolean when present. A disabled event is omitted before its script payload is read. Disabled source may contain invalid syntax, unsupported dependencies or inaccessible data without being fetched, compiled or activated.
- Active scripts are plain objects with optional inline `exec` as a string or dense string array. No coercion, getter, proxy, sparse array, inherited object shape or hidden property is accepted in event structures consumed by this parser; this does not claim that the entire legacy importDocument entry point has been hardened. Missing/empty source remains empty. Existing per-line newline joining and collection → folder → request order are retained.
- `type` is optional text metadata, not a language switch or an allowlist. `application/javascript` and other labels are accepted; all executable inline source still uses the existing JavaScript runtime. This does **not** add any other language support.
- Active `src` is rejected even with inline fallback. No local file or remote URL is read. `script.disabled` is rejected: it is not a v2.1 event enablement switch, and this importer does not invent one.
- `id`, `name` and `description` are accepted descriptive metadata, not executable references. Description supports string, null, or its schema object (`content`, `type`, inert `version`). It is validated but not retained by the canonical request model. Unknown fields, including `packages`/`requests` execution dependencies, are rejected rather than silently discarded.
- The existing 100000-character per-phase executable limit remains; the pure parser applies it before joining its own source. Lists also have a 100000-entry safety ceiling. The aggregate inherited source is checked by the parser before joining, and again by `normalizeRequest`/`scriptStages`; existing owner import body and persistence limits are unchanged.

This is canonical active-code import, not a lossless Postman archive or full SDK. Disabled source and descriptive metadata are not archived. Existing concatenated lexical scope behavior is unchanged; separate event VM scopes, package resolution and Postman export are out of scope. Workbench backup preserves the resulting request and frozen definitions; incompatible native script export keeps its existing explicit refusal.

## Atomicity and verification

All events normalize before `importDocument` returns its request batch. `importIntoProject` only then mutates requests, and owner import saves only after success. Tests cover a good item followed by invalid event input, unchanged input/project/disk, and no HTTP during import.

`postman-event-scripts.test.mjs` is dependency-free apart from Node built-ins and may be run locally. The owner workflow test is intended for ordinary CI: it imports a nested collection, checks active phase order and disabled sentinels against real loopback HTTP, restarts persistence, freezes cases/plans, edits live code, and restores a backup. It does not increase budgets or exercise XML, databases, native SQLite, pressure or the original GUI. During implementation only the pure test and syntax/format checks were run locally; CI workflow execution is pending until separately reported.
