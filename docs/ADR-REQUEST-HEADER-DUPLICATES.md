# Repeated ordinary request headers

The request editor and script HeaderList preserve duplicate rows, but the HTTP
executor and cURL exporter previously converted them with last-value-wins object
assignment. A red real-HTTP regression demonstrated that the first value was
silently lost. Build the same case-insensitive header map in both paths, retaining
multiple enabled ordinary values as arrays in source order. Disabled rows do not
participate. Single values remain strings and existing validation stays enabled.

Node24 documents string-array header values as the way to send repeated names:
https://nodejs.org/docs/latest-v24.x/api/http.html#requestsetheadername-value .
HTTP/1 wire tests inspect raw header values; HTTP/2 verifies the combined received
value. cURL emits one -H option per value, retaining its existing empty-value
semicolon syntax; fixed loopback integration executes generated cURL commands.
No user-supplied shell command or remote service is executed by these tests.

Do not convert ambiguous control/authentication fields into repeated wire fields.
Duplicate Host, framing/connection fields, authorization fields and specified
single-value request fields reject before connection. This deliberately replaces
silent last-value-wins handling with an explicit error. Signed AWS/Hawk/EdgeGrid
requests with repeated ordinary headers also reject until their canonicalization
is independently verified; do not silently coerce arrays through signing code.
Other authentication, cookie-session precedence, limits and TLS checks remain.
No attempt is made to send malformed request framing or relax the HTTP parser.

This preserves repeated ordinary header values, not original case spelling or
all field-line ordering across different names. Server parsers may combine field
values according to HTTP semantics. It is not complete original runtime parity.
Browser coverage adds repeated headers without removing prior null, disabled or
live-entry checks. Existing live-entry HTTP test now expects both retained values
rather than reinforcing the old transport loss. Exact-head CI remains required.
