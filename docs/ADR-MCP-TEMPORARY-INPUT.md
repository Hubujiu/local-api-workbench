# Temporary inputs for saved API execution

`localapi_execute_api` accepts optional `input` containing `query`, `path`,
`headers`, `cookies`, `body`, and `auth`. It still requires the existing explicit
project, write, and execution grants. The effective saved request is cloned after
service/environment resolution. Only that execution snapshot changes; the saved
request, scripts, URL, method, TLS options, and environment selection are not
rewritten. Normal execution history and script variable writeback still occur.

Parameter dictionaries may override only existing saved keys. Overridden rows
are enabled in the snapshot, including all saved duplicate rows for that key.
Header matching is case-insensitive; case-duplicate input keys are rejected.
Unknown input keys fail explicitly instead of silently ignoring caller mistakes.
Null parameter values become empty strings; other JSON values are serialized.
Path encoding and header/URL validation remain the runtime's responsibility.

JSON and MessagePack bodies accept a whole JSON value, not a merge patch. Text,
raw, XML, HTML, and JavaScript bodies accept strings. Form bodies accept declared
text fields only; binary and file overrides are unsupported. Auth overrides are
restricted to existing fields of the same type, recursively, and cannot switch the
authentication type. A missing credential field must first be configured in the
saved API. Temporary input is limited to 1 MiB of UTF-8 JSON; the existing request
body, sandbox, and timeout limits remain unchanged.

“Temporary” does not mean secret or redacted. Existing local execution evidence
can contain these inputs and credentials, and project data remains plaintext.
Do not use this interface to assume secret-safe history storage. Existing scripts
and templated configuration still execute normally; this is not a new network
isolation or origin-confinement boundary.

Static inspection of the official Offline 2.0.0 execution module identified
parameter, body, and auth override behavior. This implementation deliberately
rejects unknown parameters and limits auth replacement more strictly. It does not
claim exact MCP wire compatibility, native-client validation, or free-tier
availability solely from the bundled code. No vendor implementation is included.
