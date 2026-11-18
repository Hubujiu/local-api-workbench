# Protocol session read reconciliation

The owner TCP/WebSocket/SSE controller can recover a lost connection response by
refreshing the existing intent. A validated same-instance, same-intent receipt
whose phase is `started` restores the current session without another connection
POST. Previously, polling preserved `uncertain-start` forever and only reloading
the page could recover the same receipt.

A validated terminal snapshot also releases the local lifecycle lock after an
uncertain send or stop. The previous send's remote outcome remains unknown and
its warning survives persistence and reload. A new connection is a new intent,
not a replay or a claim that the prior message was withdrawn. A contradictory
`expired` or `cancelled` receipt containing a live session is rejected.

An open session does not prove a lost send completed, nor that a requested stop
succeeded. Those states remain blocked. Unknown server admission without terminal
local evidence, mismatched identities, malformed receipts and failed reads also
remain blocked. No retry, resend, reconnect, mutation repair or remote business
success is inferred from polling. This change does not add per-send receipts or
extend the owner intent contract to gRPC/Socket.IO or MCP operation ledgers.

Regression coverage includes the existing real TCP/HTTP lifecycle tests, a lost
start recovered through the actual refresh handler, terminal reconciliation for
unknown sends/stops, reload retention of delivery uncertainty, unknown admission,
and inconsistent expiry receipts.
