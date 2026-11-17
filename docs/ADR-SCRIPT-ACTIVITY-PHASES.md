# Script activity phase evidence and batched compatibility installation

The worker's active budget is unchanged. Its compatibility setup remains inside
the existing activity deadline, as do user functions, user script evaluation,
Promise jobs, callbacks and output serialization. The parent wall deadline,
VM memory/stack limits and all operation quotas also remain unchanged.

Compatibility installers are assembled in their original order and evaluated
through one VM entry, separated by explicit semicolons. This removes repeated
host/VM entry and compilation setup overhead; it does not move user work into
bootstrap, reset the deadline, retry a failing script, skip assertions or share
VM state between phases. A setup error still fails the phase before user code.

Small wall-time measurements distinguish compatibility installation, function
library evaluation, initial user-script evaluation, microtasks, callbacks,
Promise-state checks and serialization. The last attempted operation is recorded
separately, so exhaustion before a new operation need not be mistaken for work
performed by that operation. Measurements do not drive limits or scheduling.
Only allowlisted scalar metrics/operation names are returned in failure details;
source strings, arguments, paths and arbitrary error properties remain excluded.

Tests verify metric shape/filtering and that a deliberately smaller active
budget still terminates an infinite script. Existing sequencing, async, network,
serialization and SDK URL tests continue to enforce the same resource envelope.
Local timing samples are exploratory, not proof of a platform-specific timeout
fix. Packaged-platform results and any failing phase measurements must determine
whether more work is needed.
