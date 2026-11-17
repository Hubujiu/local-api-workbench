# Execution-start service routing context

Service bindings in saved plans remain frozen IDs, while the environment service
matrix is selected afresh for each execution. Within one execution, service
routing must not change when an unrelated owner configuration update is observed
by a successful environment/global extraction commit.

`scopedExecution.onScopeChanges` deliberately refreshes its project object after
saving variable changes. Resolving every later HTTP leaf from that mutable object
therefore previously changed the destination mid-run. The shared service resolver
now privately captures only the selected environment ID/address map, server
catalog IDs and folder bindings before execution. No variable values, complete
project, request snapshots or new persisted collection are captured. Existing
URL guards and missing-service/address errors remain in the ordinary resolver.
Owner single/run, MCP single/run and CLI consumers use this same helper; scope
callbacks, cookies, grants, cancellation, receipts and retry behavior are unchanged.
The curl exporter and nonpersistent load path do not share the scope-commit alias.

Each subsequent execution reads current configuration. A service deleted or
cleared during a run remains usable by that active run, but the next execution
fails with the existing missing-service/address error without sending HTTP.
Variables still evolve during the run and persist under the existing conflict
contract. This is not a live-reference mode, a new plan format, a network rollback,
or authorization to retry an already completed request.

## Evidence and limits

Base: remote develop `88f70bb515c48b93536b28b7fe3ec780f2e150f3`.
Before the fix, real owner, official HTTP/stdio MCP SDK and CLI workflows all sent
the second HTTP step to the newly configured loopback host after the first step's
ordinary JSON environment extraction. The first response was coordinated with a
real owner configuration update; no script/VM/XML input or pressure was used.
The original integration checkout reproduced the same issue independently.

The fixed tests cover these four complete paths, concurrent owner single execute
seeing new config, MCP single execute and denied-project grants, evolving
extraction, immutable saved plan, independent Store reads, other-project
isolation, backup/restore/restart, deleted/cleared service config, cancellation,
and a real same-variable owner conflict with retained HTTP response and no replay.
Direct resolver tests cover selected-environment/catalog/folder detachment,
missing-at-start configuration, direct and templated URLs, and host-override guards.

This branch is directly based on develop; no feature dependency is added. Native
MCP aliases and the newer typed uncertain-save receipts are absent from this base
and require separately identified integration coverage. Local targeted checks do
not establish full CI, desktop/original-product parity or complete delivery.
