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
