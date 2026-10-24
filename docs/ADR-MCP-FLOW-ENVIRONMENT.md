# MCP flow execution environment override

The original Offline 2.0.0 MCP renderer forwards an optional environment identifier
when executing a saved flow. Local API Workbench exposes this capability through
its own `localapi_execute_flow` camelCase contract as optional `environmentId`.

The selected environment is resolved within the already-authorized project before
execution. Its variables, script writeback scope, service URL bindings, and cookie
session are used consistently. Omission keeps the saved plan's environment, or
the normal project default when the plan has none. The saved plan and project
selection are not rewritten. Returned and persisted run evidence records the
actual environment ID. An unknown environment fails before a run is appended.

This does not grant execution permissions, authorize database sessions, or alter
the legacy `localapi_run_plan` argument schema. It is not a claim that all original
MCP tool names, argument shapes, or runtime behavior are equivalent.

The official MCP SDK HTTP test executes a real loopback flow in an alternate
environment, checks the expanded header and isolated script writeback, then runs
without an override to verify the original default. It also checks invalid IDs
and preservation of the saved plan and project selection.
