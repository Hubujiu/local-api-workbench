# Bounded MCP TCP interaction

This slice adds six `localapi_*_tcp_*` tools for a saved TCP connection:
start, get, send, stop, renew and operation lookup. Both HTTP and stdio require
an initialized logical owner and the project's write **and** execute grants.
No arbitrary target API, new TCP transport, storage schema or quota is added.

## Shared authority and limits

The existing `MCPWebSocketSessions` class remains the compatibility entry point.
Its typed TCP view shares the exact same owner map, operation ledger and
`ProtocolSessions` instance, rather than constructing another service or pool.
HTTP owner TCP/WS/SSE and MCP WS/TCP therefore share five connecting/open slots
and fifty retained states. A stdio launch shares its own WS/TCP pool; separate
processes remain separate pools. Existing gRPC and finite-call limits are not
redefined as a new global quota.

The 200-entry operation ledger is shared by WS/TCP for each logical owner.
Protocol type is included in fingerprints and checked for every connection and
operation lookup. Reusing an ID through the other protocol is a conflict, not
another opportunity to send or obtain another protocol's receipt. All existing
WS names, schemas, receipts and default behavior remain unchanged. A saturated
ledger does not evict deduplication evidence; existing read/stop remains usable.

HTTP DELETE/expiry, token or authorization changes, project archive and shutdown
use the existing disposal hooks for both protocols. Delayed Store reads recheck
ownership before network admission. Stdio uses its frozen startup allowlist and
trusted initialized registry identity; it does not read HTTP configuration as
live authorization. HTTP revocation is not cross-process stdio revocation, and
cross-process archive is not an immediate broadcast. EOF closes/drains the
stdio-owned resources. Crash recovery does not reconnect or replay operations.

## Explicit narrow TCP definition contract

Only saved `id`, `name`, `folder`, `type`, `url`, `port`, `message`,
`templateMode` and `receiveEncoding` fields are admitted. `message`, if present,
is bounded well-formed text. Other fields reject before opening a connection,
including explicit duration, completion, delimiterHex, sendEmptyMessage,
handshake, HTTP headers, TLS, subprotocols and scripts. This does not change the
owner endpoint or WS definition contracts. TCP TLS is not added.

Start opens but never sends the saved default message. Send requires explicit
well-formed text, including an explicit empty string, at most one MiB before
and after existing scalar template expansion. Binary outgoing objects are not
supported in this slice. `prepareWireExecution` freezes the definition and
variable context at start; later project/environment edits do not alter the
open connection or its subsequent template expansion. No environment, target,
credentials, receive encoding or script override is accepted by these tools.

## Stream evidence and outcome semantics

TCP data events are stream chunks, not application messages or packet frames.
One send can yield several received events; several writes can coalesce. UTF-8
uses the existing streaming decoder and does not promise lossless representation
of invalid bytes. For byte evidence choose the saved hex/base64 receive encoding.
Decode **each base64 event separately**, then concatenate bytes. Do not concatenate
padded base64 strings. Dropped or truncated previews cannot reconstruct the full
stream. Manual closure can discard an unfinished UTF-8 sequence and remains a
partial capture, not a completeness claim.

Existing eight-MiB representation accounting, two hundred retained events,
three-MiB durable-record cap, bounded twenty-event pages and 4096-character MCP
previews remain. dataBytes/dataHash describe encoded display representation,
not an assertion of original wire-byte length. Records and event payloads can
contain sensitive application data; this is not a redacted sharing format.

The existing explicit sixty-second lease and fifteen-minute absolute lifetime
remain. Reading, sending and HTTP keepalive do not renew. Terminal sessions
cannot renew or send. Submitted writes can be pending, locally-written or
unknown; locally-written is not remote receipt or business acceptance. Concurrent
sends reject until completion; same-operation retries return the recorded state,
never resend. Finishing settles pending sends as unknown before freezing terminal
evidence, so late write callbacks cannot promote unknown to success.

Stop waits for the initiated save attempt, not an automatic retry. Unsaved or
uncertain storage is not proof that transport never ran. Backup/restore and
restart preserve inert evidence, never the live connection or deduplication ledger.

## Verification boundary

Synthetic loopback tests cover official SDK HTTP and actual stdio child challenge/
response on one socket, typed identity conflicts, shared WS/TCP admission and
ledger limits, revocation during delayed reads, frozen templates, unknown writes,
late callbacks, terminal records, byte reconstruction and inert backup/restart.
Controlled callback tests prove local state behavior, not remote application
acknowledgement. Original WS/gRPC regressions are retained. Exact-head CI is still
required; local tests are not a claim of all external MCP clients or full TCP
application-protocol compatibility.
