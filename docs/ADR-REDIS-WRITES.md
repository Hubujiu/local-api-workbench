# Explicit single-key Redis SET

The manual database page has a separate one-request write grant. The default
query API and every session/script database connection retain the read-only
command allowlist, even if a caller supplies allowWrite. Only the manual HTTP
route dispatches to mutateRedis after an exact boolean true grant.

The target must explicitly include Redis type, host, port and database index
0–1023. Arguments must be a dense JSON array of well-formed Unicode strings, rejecting
unpaired surrogates rather than silently replacing bytes; one nonempty key and
one value are limited to 4096 UTF-8 bytes each. Only SET is accepted, optionally
with one NX or XX condition and one EX, PX or KEEPTTL expiration choice. EX/PX
accept decimal integer strings 1–2147483647. GET, absolute expiry, multiple keys,
scripting, deletion, administrative commands and arbitrary options are refused.

Redis's [SET contract](https://redis.io/docs/latest/commands/set/) determines
replacement, expiry and conditional behavior: an ordinary SET replaces the
value and removes previous expiry, KEEPTTL retains it, and an unmet NX/XX
condition returns a null reply. The UI names the exact key and explicit target,
warns about replacement, TTL loss and inability to roll back, and requires a
confirmation. Cancellation makes no database request. The grant resets after
each attempted execution or cancellation and on provider/TLS changes.

AUTH and SELECT must each acknowledge before SET is sent. SET is sent at most
once, without reconnect or automatic retry. An OK reply means acknowledged and
applied, not guaranteed disk durability; a conditional null means acknowledged
but not applied. Any error after sending SET is conservatively reported as an
uncertain outcome, including server errors: it never promises rollback or safe
replay. Errors before SET cannot cause a write. Existing verified TLS, 3-second
total deadline and response/request byte caps are unchanged.

Protocol fixtures exercise authorization, sequencing, missing acknowledgements
and no replay. HTTP and browser fixtures exercise default rejection, cancellation,
explicit execution and grant reset. An isolated real Redis CI service validates
UTF-8/CRLF values, conditions, KEEPTTL, clearing expiry and millisecond expiry;
this is not validation against a user's production database or every Redis version.

## Local write transport completion (2026-10-30)

The read-cancellation foundation already registers the owned socket's close
promise before processing responses. Its write branch called destroy() but settled without
awaiting that promise. Thus a write acknowledgement or failure could be published
before actual local transport closure. This is a demonstrated source-ordering
hole, not evidence of a permanent socket leak: destroy was already requested.

Writes now await the same actual local close boundary as reads. The first outcome
is latched before destroy, the existing three-second total deadline is cleared,
and a later close/error cannot turn a received OK or conditional null into an
unknown result. Cleanup does not wait for the peer's FIN or issue QUIT, retry,
reconnect or rollback. Existing pre-SET errors versus post-SET uncertainty, TLS
verification, single-key options and per-call write authority remain unchanged.
No native task, saved session, MCP or CLI write grant is introduced. Owner HTTP
disconnection still does not cancel an already authorized bounded write.

Independent plain/TLS half-open peers check the actual client close event using
Node's diagnostic socket channel, not server teardown or socket.destroyed alone.
They cover OK, conditional no-op, malformed ACK, EOF without ACK,
AUTH/SELECT/SET errors, the unchanged default
three-second timeout, pre-SET timeout isolation, and owner HTTP disconnection.
The real Redis CI fixture checks close-before-settlement on each acknowledged
write, retains existing value/condition/expiry readback, drops a real SET ACK
through a loopback proxy to verify unknown outcome despite actual mutation, and
checks the HTTP one-call authorization boundary and unchanged project storage.
Local close does not prove remote cessation, rollback or durable persistence.

These new runtime checks are pending exact-head CI. Local development validation
is limited to syntax/format and static review; no local app, provider or database
was run for this change.

## Canonical owner SET over pinned SSH

Canonical HTTP configuration may supply the explicit `ssh` object described in
[ADR-DATABASE-SSH.md](ADR-DATABASE-SSH.md). Only the owner-authenticated HTTP
route with `allowWrite: true` can execute SET. Session, script, CLI and MCP grants
remain read-only, including after a successful owner write. The frontend still
has no SSH controls; this is a canonical backend/configuration capability.

One 100–3000 ms Redis deadline starts before SSH establishment and includes TLS,
AUTH, SELECT and SET. There is no additional Redis budget after tunneling. An
operation-owned abort controller preserves the first cancellation/deadline reason
without breaking the native direct-SET observer's post-dispatch draining contract.
TLS verifies the logical Redis DNS hostname through the channel, never the SSH
host or a local forwarding address. Malformed configuration, unverified host keys,
authentication failure and denied forwarding cannot fall back to a direct connection.

Settlement awaits the RESP/TLS stream, SSH channel and underlying SSH transport
close. An ACK or conditional no-op stays acknowledged during cleanup. Every error
after SET dispatch remains uncertain, with no retry/replay/rollback claim. Native
active-SSH import and native owner-broker SET over SSH remain unsupported; a plain
native read source can be explicitly rebound to a canonical SSH session.

Pure tests guard validation before transport creation and the native write limit.
CI protocol peers cover password/key authentication, verified TLS, AUTH/SELECT,
ACK/no-op/uncertainty, deadlines/cancellation, capacity recovery, project grants,
revocation, HTTP disconnect and credential nonpersistence. Real Redis 7.2 CI
acceptance separately checks tunneled values/conditions/expiry, a lost real SET
ACK, native read rebinding, CLI stdin configuration, HTTP MCP and MCP stdio
startup grants, process restart and explicit regrant. TLS peer fixtures are not
real Redis TLS acceptance. Runtime acceptance remains pending exact-head CI;
local validation does not run servers, apps, SDKs or network workflows.
