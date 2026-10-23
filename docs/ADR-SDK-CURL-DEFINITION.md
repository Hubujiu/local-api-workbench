# Bounded cURL export of SDK URL request definitions

The SDK URL mode initially rejected all cURL output. It now permits request
**definitions without pre-request scripts or operations**, using the same reviewed
URL renderer as execution. This is not export of a script program or an execution
plan. OpenAPI export remains rejected because its parameter model has not yet
been reconciled with SDK URL collection semantics.

The authenticated export endpoint applies the existing project/folder shared
script rules before its preflight check. Any effective pre-request script, or
pre-request operation, rejects export **before** dynamic providers are invoked.
Opting out of inherited scripts retains the same meaning as in request execution.
No JavaScript, database operation or subrequest is executed just to obtain cURL.
Post-request assertions are not represented by cURL.

The existing dynamic resolver handles environment values, functions and provider
budgets once. The SDK URL is then rendered using original raw-query spelling and
form-origin encoding, preserving duplicates, disabled members and empty-value
policy. Query and path tables are cleared from the ephemeral export copy to avoid
double appending. Service binding occurs **after** this rendering, so a bound
relative URL does not revert to its unbound SDK snapshot. The saved definition
and runtime snapshots are not mutated.

Direct synchronous `toCurl` calls reject unprocessed dynamic providers. Disabled
query rows do not require provider evaluation. Existing cURL restrictions for
signatures, binary/file bodies, TLS material and protocol/proxy limitations remain
in force. Shell quoting and `--disable`, `--globoff` and explicit proxy behavior
are unchanged. The UI mode notice and generated definition documentation state
the narrowed scope instead of implying full script equivalence.

Verification includes actual loopback HTTP/1.1 and HTTP/2 requests executed from
fixed generated cURL commands and compared with the application's transport;
selected-environment and service-binding export through the authenticated API;
inherited-script rejection before an undefined provider can run; input immutability;
and the real browser cURL dialog for a script-free SDK definition. Tests never
execute shell commands derived from third-party or user-supplied fixtures.
