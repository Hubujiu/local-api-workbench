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
