# Explicit intent for destructive MCP calls

Offline 2.0.0 exposes a required `confirm` input for deletion, and inspected
renderer handlers reject anything other than the boolean `true`. Workbench now
requires `confirm: true` on its six destructive MCP tools: API deletion, environment
deletion, shared-service deletion, environment/global variable deletion, and flow
deletion. Missing, false, string, numeric and null values fail before mutation.

Tool discovery declares the boolean constant and required field. The dispatcher
also checks it independently at runtime. This intentionally makes old destructive
calls without confirmation fail explicitly rather than delete silently. Read-only
project grants and the separate write permission remain mandatory; confirmation
cannot make an unavailable tool callable. It is a caller's explicit intent flag,
not proof of a human approval ceremony and not a replacement for authorization.

Ordinary HTTP/UI environment operations are unchanged. API recycle-bin behavior
and retention of flow execution evidence are unchanged. Tests verify every exposed
delete tool leaves persisted state untouched on rejection, accepts explicit intent
only with write grants, and preserves unrelated variables. The official MCP SDK
HTTP test also checks rejection, successful flow deletion and retained run detail.
