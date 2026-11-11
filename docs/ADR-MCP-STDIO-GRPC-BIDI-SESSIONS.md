# Stateful stdio MCP gRPC bidirectional sessions

## Scope and identity

This extends the HTTP bidi adapter to the independently launched stdio host. It
reuses GrpcSessions, its transport/evidence codec and the six tools; it does not
add unary, client-only or server-only interactive methods. Start references a
saved definition only. No temporary target, metadata/TLS override, proto source,
initial message, or script can be supplied through this interface.

Explicit `--write --execute --project` startup grants are required. The private
interactive gRPC project allowlist is copied at startup; later project imports
or creations do not expand it. The same private registry owner used by stdio
WebSocket is injected as grpcOwner only after initialize's successful response
write completes. Arguments cannot supply identity. Reinitialization does not
replace the owner, clear either ledger, or extend any deadline.

## Shared gRPC capacity and closure

One runtime creates one GrpcSlots instance for both GrpcSessions and its injected
finite grpcExecutor. This includes finite gRPC work reached through canonical or
native MCP plans. The executor acquires exactly one slot, tracks its task before
transport admission, and releases exactly once in finally. The existing finite
MCP counter can impose an additional bound but does not replace this shared pool.
Five interactive streams block a finite RPC; four streams plus one finite RPC
block a sixth call. A terminal call releases its active slot independently of
storage success. Interactive failed/unknown saves retain the existing bounded
fifty-session evidence capacity.

Registry disposal and context close synchronously close finite-call admission
and abort its host signal, as well as revoking interactive owners. Pending
finite task microtasks observe the aborted signal before opening transport.
Disposal composes both WebSocket and gRPC cleanup; neither hook replaces the
other. The transport's EOF/input/output/error/timeout and fatal budget paths
wait for pending handlers, registry disposal, finite work and both protocol
managers' storage drain. Context close is idempotent and also handles a runtime
that has not yet entered serveMCPStdio. A pending project read cannot admit a
late stream/send/half-close after ownership is revoked.

Cancel and disposal use the adapter's `retryStorage:false`; they do not invoke
the owner API's optional terminal storage retry. A failed original save is not
success and is never repaired by repeating a network action. Shutdown can wait
for unresolved storage; it does not falsely acknowledge completed persistence.

## Deadline and operation contract

The saved gRPC timeoutMs remains the absolute total deadline: 50–30000ms,
default 5000ms. The original timer, monotonic elapsed-time checks and gRPC
transport deadline remain unchanged. Reads, sends, half-close and repeated
initialize do not extend it. There is no gRPC lease-renew tool, and WebSocket's
60-second lease/fifteen-minute lifetime must not be applied to gRPC.

Start/send/half-close have a separate 200-operation gRPC ledger for this owner.
Same ID and arguments return recorded state; different content rejects. A
pending admission or write prevents another send/half-close on that stream.
A `locally-written` or `half-closed` receipt is not remote acceptance. Termination
freezes unknown operations and evidence; late callbacks cannot rewrite them.
The original 100-request/100-response and one-MiB request JSON/wire/response
budgets, bounded pages, status distinctions and failed-save retention remain.
WebSocket and gRPC ledgers are each bounded, not a combined 200-entry promise.

## Cross-process limitations

All pools, identities, ledgers and startup grants are per independent stdio
instance. HTTP permission changes, token rotation or an owner's server shutdown
do not revoke another stdio process. Terminate/restart the stdio process to
change its startup grant. Project existence/archive is checked at each start,
send and half-close, but another process's archive is not a realtime revocation
broadcast to existing receive/read activity. The original deadline still applies.
There is no cross-process quota, coordination or exactly-once guarantee.

EOF and transport failures are the graceful shutdown paths tested here. No
SIGINT/SIGTERM handler, SIGKILL/crash persistence or abrupt-termination drain is
promised. Parent HTTP gRPC CI status is separate evidence; local stdio tests do
not retroactively establish its CI outcome.

## Verification contract

Real SDK stdio tests exercise same-stream challenge/send/half-close, all six tool
names and grants, and mixed finite/interactive quota admission. Lifecycle tests
cover trusted initialization, frozen grants, owner isolation, pending-read
revocation, unchanged deadlines, unknown late callbacks, bounded evidence and
simultaneous finite/WebSocket/gRPC drain. Existing HTTP gRPC, stdio WebSocket and
finite-plan regressions remain required. With both adapters enabled, discovery
is 69 localapi plus 30 apipost tools (99 total); no-service construction remains
57 plus 30 (87).
