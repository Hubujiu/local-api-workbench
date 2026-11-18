# Read-only recovery of a known gRPC creation receipt

The owner streaming gRPC panel retains the exact session ID from a validated
creation response before checking whether the originating view is still current.
A delayed response after navigation remains unadopted, but its ID is persisted
with the existing recovery flags (not metadata, credentials, payloads or schema).
A creation response followed by local persistence failure has the same recovery
path once storage works again.

Explicit read-only refresh uses the original ID when no session is selected.
Only a valid authenticated snapshot for that exact retained creation ID may clear
`uncertainStart`. Merely entering an unrelated session ID or repeatedly reading
an arbitrary existing session cannot clear it. A new explicit start discards the
previous terminal selection and correlation before dispatch, preventing an old
session from being mistaken for the new creation attempt. Failed reads, invalid
snapshots, foreign projects and failed recovery-marker persistence remain blocked.

This does not retry creation, send a stream message, or infer remote business
success. Unknown send/half-close flags and terminal persistence concerns remain
independent. If no creation response or ID was ever received, this feature cannot
recover it: no matching by definition, session search or automatic recreation is
performed. Such complete response loss still requires a server-side start intent
contract, which is outside this change.

Validation uses the actual app persistence adapter and a real loopback HTTP +
grpc-js bidi fixture. A navigation-delayed creation response is retained, reloaded,
and reconciled by one GET, with one total stream creation and zero stream messages.
A foreign project's read cannot recover that original stream. Unit tests cover
unrelated IDs, old correlation replacement and persistence failures.
