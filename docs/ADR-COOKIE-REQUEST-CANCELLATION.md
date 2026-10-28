# Cookie waits are part of the request deadline

## Scope

The request is normalized first, then receives one absolute monotonic deadline
(`performance.now()` milliseconds). Initial Cookie header acquisition, connection
preparation, network exchange, NTLM Cookie exchange, final capture and private
Digest replay share this deadline. Authentication replay never receives a fresh
budget. `response.duration` remains transport timing, starting before connection
preparation, not the initial Cookie wait or final persistence. Plan duration is
end-to-end. No redirect support is introduced here.

`acquireFileLock`, Cookie `transact`, `header` and `capture` accept optional
`{ signal, deadline }`. A supplied deadline must be a finite number in the local
monotonic clock domain, not a Unix timestamp. Memory sessions observe the same
controls before their synchronous work. Existing manual Cookie APIs, opt-in
settings and Store callers without controls retain their existing defaults.

## Queue, disk ownership and publication

Cancellation/deadline stops a waiting queue slot promptly, without beginning its
transaction. Its own gate is released, but its tail remains chained to the live
predecessor until that predecessor finishes. New successors cannot bypass it.
Disk polling observes the same controls; the default independent 2-second idle
and 10-second hard limits, owner-change progress rule, demonstrably dead-owner
recovery, nonce-checked release and Windows mkdir-only EPERM retry remain.

Filesystem operations are cooperative, not hard-cancelled OS system calls. After
creating a lock directory, acquisition finishes the ownership receipt so it can
release its own nonce if cancellation happened during acquisition. Transactions
check before the callback and publication. If cancellation happens during a temp
write, the write is awaited, the owned temp removed, and no rename starts. The
atomic rename is the commit boundary: once issued, cancellation cannot promise
rollback. A completed rename remains committed even if the request subsequently
reports cancelled/timed out. Cleanup always waits for the operations it owns;
there is no abandoned mutating `Promise.race`.

## Completed HTTP evidence is not success

A completed HTTP exchange followed by cancellation/deadline during finalization
throws an internal WeakMap-branded failure. Only the trusted reader may recover
its actual response; arbitrary `error.response`/`failure` properties are ignored.
The response and its headers retain their original object identity. A bounded
`failure` object is available on the response and step:

```json
{"phase":"cookie-capture","code":"REQUEST_TIMEOUT","retry_safe":false}
```

Other phases are `auth-cookie` and `response-finalization`; the other code is
`REQUEST_CANCELLED`. These fields contain no error text or credentials. Owner
execute exposes this metadata alongside the real HTTP status, `outcome: failed`
and error text; CLI/MCP full-run records retain it. No automatic retry is added.
The plan skips response assertions, extraction and after work, and stops before
the next step. External abort gives overall `cancelled`; deadline gives `failed`.
An immediate signal check after executor return also covers cancellation with
no Set-Cookie or a caller-supplied executor. Earlier before-stage effects and
already committed state are not rolled back. Ordinary Cookie persistence errors
remain a `cookieError` warning on the completed response.

Cookie jars remain local-only under `.cookie-jars`, outside portable project
backup/restore. Existing request/response history can still contain Cookie
headers and should be reviewed before sharing; this is not a redaction feature.

## Verification boundaries

The preceding held-lock reproduction demonstrated bugs, not fixed acceptance.
Acceptance uses separately inspected ordinary file-lock, Cookie and loopback HTTP
tests. VM/script, XML, database, OOM and original-application workloads are outside
this local verification batch. Platform-specific claims require platform CI.
