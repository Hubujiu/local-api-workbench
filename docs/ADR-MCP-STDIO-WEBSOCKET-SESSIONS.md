# Stateful stdio MCP WebSocket sessions

## Scope and authorization

The six WebSocket tools share the HTTP implementation and wire evidence format,
but each stdio launch is an independent host. They are available only with
explicit `--write --execute` and at least one `--project` argument. The WebSocket
project allowlist is a private copy of those launch arguments. Importing or
creating another project through MCP does not expand this execution grant.
No gRPC, temporary endpoint, header/TLS override, or script execution is added.

A successful initialize response must finish writing before the transport
supplies its private owner object to tool dispatch. JSON arguments cannot
provide this object. Repeated initialize does not replace the owner or reset the
operation ledger. The identity belongs to this registry instance and process,
not a reusable session string or an HTTP bearer token. The transport's existing
random instance epoch also remains independent for manual-import ownership.

## Termination and evidence

EOF, an incomplete frame at EOF, input error/close, output error/close/write
failure/timeout, or fatal input/handler budget exhaustion enters the same stop
path. It synchronously stops input admission and closes the registry. This
revokes the owner and terminates owned sockets before awaiting pending handlers,
owner disposal, and protocol/storage drain. A pending project read must recheck
ownership and cannot start a socket or send after termination. The context also
has an idempotent asynchronous close, awaited by the entry point's finally block,
including when startup or transport setup fails.

The shared wire recorder makes one automatic persistence attempt. Close waits
for its outcome, not a claim of storage success. Failed saves remain failures;
close does not reconnect, resend, or retry storage. A submitted send without a
confirmed local callback becomes unknown; a late callback cannot revise frozen
history. Retention timers are cleared when the context closes. A stalled storage
operation can delay graceful exit; we do not falsely report a successful drain.
SIGKILL, abrupt process termination, and crashes cannot guarantee final evidence.
The first slice relies on stdin EOF/error for graceful client termination and
does not promise signal-handler-based shutdown.

## Budgets and idempotency

Each stdio instance has its own five-active / fifty-retained ProtocolSessions
pool. Failed-save records retain slots. This pool is not shared with the owner
HTTP server, other stdio processes, or the separate finite-execution pool.
The same 60-second explicitly renewed lease, fifteen-minute absolute lifetime,
one-MiB text-send limit, eight-MiB cumulative data limit, bounded event pages,
and 200-entry operation ledger apply. Reading does not renew the lease.
One connection allows only one unconfirmed MCP send; new sends are rejected,
not queued. Same operation ID and arguments returns prior state, not a replay;
a different fingerprint is rejected. A full ledger never evicts deduplication.
New processes or restart create new ledgers. There is no cross-process or
cross-crash exactly-once promise. Local write completion is not remote receipt.

## Explicit cross-process limitations

The process uses fixed startup authorization. Changing the owner's HTTP MCP
permissions, disabling HTTP MCP, or rotating its bearer token does **not** revoke
an already running independent stdio process. Terminate/restart that process to
revoke or change its launch grant. Merely editing a configuration file does not
change its grant.

Start and send reread project state and reject missing/archived projects. An
archive performed by another process is not an immediate revocation broadcast:
existing socket receive activity, bounded reads and explicit renewals are not
synchronously stopped by that external write. The lease and absolute deadline
still apply. Realtime owner-driven revocation and unified cross-process quotas
would require a separate authenticated coordination design and are not claimed.

## Verification

Tests cover the official SDK stdio child process and real loopback sockets,
transport initialization/termination, frozen launch grants, pending-store
revocation, independent instance quotas and ledgers, persistence drain, and
inherited lease/payload/event budgets. HTTP regression tests ensure the shared
recorder and transport-neutral tool descriptions do not change HTTP ownership.
EOF tests distinguish waiting for a save attempt from successfully saving it.
