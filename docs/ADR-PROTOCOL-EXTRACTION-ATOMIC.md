# Ordinary protocol extraction batches

The shared gRPC, Socket.IO and TCP/WebSocket/SSE plan-result branch prepares every declared extraction against the completed protocol result before changing any variable scope. The whole candidate includes runtime values, hidden-name masks, environment and globals. Duplicate targets retain declaration-order, last-write behavior. Failed extraction publishes an empty `record.extracted` and leaves the previous effective values available to the next step. Continuing after an ordinary failed protocol step is existing policy and is unchanged.

Environment/global changes are submitted through the existing scope-persistence callback once. The local batch and `record.extracted` publish only after that callback succeeds. A genuine `ProjectCommitUncertain` reports `scopeCommit: {outcome: "unknown", retrySafe: false}` without raw causes or project IDs; it means this execution did not adopt the batch, not that disk was rolled back. No protocol call is retried. A cancellation observed before this commit boundary prevents the batch; a storage write already confirmed during cancellation is not falsely undone.

This change does not alter HTTP extraction, native tasks, script behavior, protocol request side effects, budgets or the continue-after-failure policy. Its minimal base is PR30 (truthful run receipts), already dependent on PR17 (typed journal outcomes); root integration and unrelated native-script changes are not dependencies.

The initial real loopback regression reproduced all three branches sending `fresh-loopback-token` in a following HTTP request after a later extraction failed. The corrected batch keeps the old runtime token and hidden masks, with no partial extraction receipt. Broader persistence/cancellation/frozen restoration verification is in progress until the exact final commit is validated.

## Completed local workflow evidence

The real gRPC, Socket.IO acknowledgement and TCP fixtures each exercise a later
HTTP consumer. They cover missing-last failure, hidden runtime retention,
complete mixed-scope success and ordered duplicate targets, ordinary save errors,
forged unknown codes, failed assertions and transports, and cancellation after
the peer has received the request. Cancellation retains the transport result and
adds the cancellation diagnostic regardless of assertion/status success.

Owned filesystem fixtures cover invalid pre-journal history and a history-path
obstacle inserted after the real Store read, causing an actual typed post-journal
uncertain commit. The local execution keeps the old batch; repairing the obstacle
and opening a new Store recovers the actual new persistent values. This is
explicitly not disk rollback. Frozen plans, successful result history, backup
restoration, restart and another project's unchanged state are checked for all
three protocol families. These local results do not substitute for exact-head CI
or the parent's combined MCP/CLI acceptance.
