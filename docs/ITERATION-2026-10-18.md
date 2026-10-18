# 2026-10-18 P0 parity iteration — in progress

The frozen audit in PARITY-AUDIT.md describes d383014, not this evolving tree. It must not be silently rewritten as though all gaps are closed.

Implemented in this iteration:
- Shared environment domain: global/environment precedence, explicit selected environment, shared service names with per-environment base addresses, validation and CRUD.
- MCP adds project creation with scoped authorization, environment/service/global lifecycle, single API execution, explicit plan CRUD and run lookup. Existing nine tool names remain backward compatible; 34 advertised tools comprise 30 current capabilities plus four legacy aliases.
- Runtime extraction can be read through MCP and shared with manual debugging; saved configuration changes invalidate old runtime values.
- HTTP/plan/CLI/load/cURL paths use environment/global values and service binding.
- Plan description, updated time and AI/manual origin marker; UI has explicit description editing and deletion. Field-by-field orange highlights and live AI execution remain unfinished.
- UI supports global editing, shared service environment addresses and request service binding.

Verification before publication: 71 local tests passed, no skips; full current-head CI and expanded browser interaction must still pass. Tests use local fixtures only. Full source audit, client-specific MCP configuration, visual fidelity, smart Mock, API lifecycle fields and other documented gaps remain open.

Design decisions:
- Globals are overridden by environment values, then temporary execution values.
- Deleting an environment requires at least one remaining environment; the selected environment and affected saved plans are reassigned to the first remaining environment.
- Deleting a service removes its address mappings, but preserves bound request definitions so execution fails explicitly until reconfigured.
- MCP-created projects are authorized only within the already write-enabled current service configuration.
- No main merge, deployment, user-computer access or delegated coding task.

Second pass:
- Plan versioning now tracks AI/manual origin independently for name, description, environment and each changed step. Manual edits clear only their changed origin, leaving unchanged AI values marked.
- HTTP MCP exposes bounded running/recent activity and step progress; UI shows running tasks without replacing unsaved content. Standalone stdio progress is not yet bridged to another desktop process.
- Browser run 39084101925 failed because the new navigation test used an ambiguous settings selector (both rail and environment shortcut). Selector is now scoped to the rail; no assertion removed.
- Current local suite: 73 passing tests. Exact new-head browser/desktop CI still required.

Third pass:
- Independent interface-case snapshots now have create/edit/delete/run UI and persisted request/assertion/function snapshots. This replaces the earlier plan-only shortcut.
- Added project custom functions, status-code dictionary, typed custom API properties and lifecycle statuses. Shared functions run inside QuickJS as utils.name(...args), with a total source-size limit; they do not acquire host filesystem/network APIs.
- Shared functions are copied into plans/cases so future project edits do not silently mutate saved tests.
- Settings gets a secondary navigation tied to real resource sections. Workbench body types use radio selectors; warm dark palette and reference viewport dimensions have passed run 39084413706 on e0d6bcf, prior to these resource/case changes.
- Latest local suite: 76 passing tests. Expanded browser case/resource checks must pass on this next exact head; not claimed complete.

Fourth pass:
- Smart Mock implements ordered enabled rules, AND conditions on method/query/headers/body paths, bounded delay and custom safe response headers. No regex evaluation or host script execution; default response examples remain fallback.
- Project Mock switch is editable in settings. Rule semantics are an explicit independent implementation because the public screenshot names the feature but does not expose all original matching rules.
- Added usable parameter-helper drawer (variable insertion, function names, request schema), and send/save dropdown actions.
- Local fixture verification now 78 tests; browser adds repeated helper open/close, cURL menu and real smart Mock response coverage. Exact-head CI remains required.

Fifth pass: Git-readable storage
- New saves use project-ID directories with separate apis, envs, settings, plans, cases and history files. Filenames derive safely from stable record IDs; this is not Apipost's proprietary format.
- Legacy single JSON projects remain readable. First save writes the split format and leaves the original single file untouched as a migration backup.
- A complete transaction journal allows roll-forward after process interruption. Readers and writers take the same project lock; no power-loss durability guarantee is claimed.
- Configuration fingerprints detect external Git/file edits even if a version counter was not updated, rejecting stale UI saves.
- history is excluded in newly generated .gitignore; a Git checkout lacking history can open with empty history. User-supplied .gitignore files are not overwritten.
- 81 local tests pass, including legacy preservation, interrupted-write recovery and external-file conflict detection.
- Previous 02d27bb browser/desktop/core/database all passed; strict formatting failed on a non-idempotent first formatting pass of a chained test expression. The second formatting pass was checked locally; gate remains unchanged.

Sixth pass:
- Plan page is split into plan/record tabs with a left plan list and right editor; step drag/drop reordering complements keyboard-accessible up buttons.
- Plan name/description edits participate in unsaved-change handling and project save, rather than disappearing on navigation. Manual saves recompute provenance only for changed fields; untouched plans keep their timestamp.
- Split-file migration candidate da390221 passed all seven jobs in run 39085352021. Current plan-layout edits require their own CI.

Seventh pass:
- Real HTTP/2 direct transport (cleartext prior knowledge and verified TLS/custom CA) is selectable beside the URL. It reuses the existing body/response size limits, decode and request deadline. HTTP/2 proxy and cURL export are explicitly rejected rather than silently downgraded.
- Transport API basis: https://nodejs.org/api/http2.html (clienthttp2session.request, endStream and AbortSignal). Local real HTTP/2 fixture and certificate tests added; 83 local tests pass.
- Plan-layout run 39085547166 passed all jobs except browser: the test still expected the old “＋ 新建计划” label. It now targets the stable new-plan control; functionality assertion remains.

Eighth pass:
- API parameter definitions retain schema/type, required flags and descriptions; response definitions retain status/content/schema/example metadata through OpenAPI import/export.
- Export keeps operation IDs and concrete server origins; exported response metadata is cloned rather than mutating the live project.
- Added response-definition editor, parameter-definition controls, response-example tab and single-interface offline HTML sharing. Export includes typed parameter and schema details with escaping/CSP.
- Running a plan first saves pending edits, so execution does not silently validate an older plan.
- Latest 3b3f512 passed all seven CI jobs in run 39085713221, including new direct HTTP/2 tests. Current local suite has 84 tests; latest documentation/share browser regression still requires CI.

Ninth pass:
- MCP authorization remains off by default; explicit opt-in can persist the project grants, local port and connection key. Rotation immediately revokes the old key. Archive revocations are persisted.
- If the remembered port is occupied, the workbench remains usable on a new port but MCP fails closed, requiring fresh authorization/configuration. Credential files receive Git ignore entries; this does not untrack files a user already tracked manually.
- Client configuration views cover Cursor, Codex TOML, Claude Code, VS Code, WorkBuddy and a generic Trae HTTP template. No actual Codex/other Agent task is started; per-client live integration is not claimed.
- Format references: https://developers.openai.com/learn/docs-mcp ; https://developers.openai.com/ja-JP/docs/config-file/config-reference ; https://code.visualstudio.com/docs/agents/reference/mcp-configuration ; https://cloud.tencent.com/document/product/1831/137039 . Trae remains explicitly labeled generic/unverified.
- UI project saves no longer resend potentially huge history/run bodies; server preserves authoritative history.
- 87 local tests pass. 9bbf29c passed all seven jobs in run 39085954384 before the persistence/config-view changes.

Tenth pass:
- Unified project tree now includes HTTP definitions, documents and saved SSE/WebSocket/TCP connection definitions, with type and keyword filters. Clicking a saved protocol never automatically connects.
- Protocol definitions are persisted separately and use validated stable IDs. Session registry is capped at 50 retained sessions, in addition to the existing five active connections.
- Browser regression exposed a genuine modal bug: client-tab buttons inside a dialog form submitted/closed it. All content action buttons are now explicitly type=button; the repeated client-tab test is retained.
- 88 local tests pass. This tree and modal fix must pass exact-head browser/desktop CI.

Eleventh pass: parameter dictionary semantics
- Rechecked https://wiki.apipost.cn/docs/project_set/key_description/ as supplementary SaaS documentation because offline help says common usage is retained. It distinguishes reusable parameter descriptions/defaults/types/examples/enums from schema models; the two are now separate in this app.
- Parameter dictionary supports persistent entries, optional built-in common fields, explicit reuse in parameter rows, temporary captured descriptions, and KV/JSON/common MySQL CREATE TABLE preview import. Source duplicates select the more complete definition; existing key/type conflicts are unselected until the user chooses them.
- MySQL DDL is parsed as data only, never executed, and unsupported syntax/types fail explicitly. This does not claim a full SQL grammar or paid AI fill.
- 90 local tests pass. Browser adds dictionary import/reload/reuse. The prior tree run failed only because a document heading now also exists in the tree; the test locator is scoped to the heading, not weakened.

Twelfth pass:
- a5d5853483f143efa9e5376630dbb594ff745e0d passed all seven jobs in run 39086847229, including dictionary import/reload/reuse and packaged Windows startup.
- The JSON body helper now shows reusable dictionary parameters and inserts typed default/example values, refusing duplicate keys or non-object/invalid JSON without overwriting existing data.
- 91 local tests pass. A browser regression checks insertion preserves existing body fields; this new change still requires its own exact-head CI.
- Inspected the actual a5d5853 browser PNGs at 1328×876: parameter-helper Chinese text overlapped vertically, and the body-toolbar hint wrapped awkwardly. Helper text now has an explicit upright span and measured browser regression; toolbar items wrap as whole controls.

Thirteenth pass:
- Dictionary helper commit 090686c passed all seven jobs in run 39087172439.
- Expanded variable extraction to response headers (case-insensitive), Set-Cookie values, duration and whole text, retaining existing JSON-path behavior. Missing values fail with actual response evidence; reserved variable names are rejected. XML/XPath, regex and persisted environment/global destination scopes remain unsupported.
- Source scope: https://wiki.apipost.cn/docs/http_debug/set-valuable/ is supplementary online documentation, not proof of identical offline semantics.
- 93 local tests pass; browser adds extraction-source save/reload.
- Visual regression a07aa54 correctly failed: this Linux font's vertical glyph metrics still overlap with writing-mode. Replaced vertical shaping with four ordinary horizontal glyph rows rather than weakening the height check.

Fourteenth pass:
- Replaced the JSON-only step-edit modal with a snapshot form: name, method, URL, enabled Header/Query/Path/Cookie rows, body mode/content and step scripts.
- Editing retains IDs, parameter metadata, authentication, form-file data, assertions and other untouched advanced fields. The source API is not mutated. Advanced plan JSON remains available.
- 94 local tests pass; browser checks add/save/reopen and actual execution with a step header, and captures the editor screenshot.

Fifteenth pass:
- b75f80e passed all seven jobs in run 39087539435, including the new visual snapshot editor and persisted extraction-source UI.
- Re-opened the official light screenshot in the own cloud browser. Moved project controls into the center header group and the execution-plan entry to the header, removing its extra rail icon. Remaining protocol/database rail placement is still different.
