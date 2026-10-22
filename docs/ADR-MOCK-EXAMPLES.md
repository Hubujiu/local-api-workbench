# Exact editable Mock examples

A response example's explicit empty body remains empty; missing body metadata
still has the historical `{}` fallback. Literal response headers and a bounded
delay are now honored, so imported XML/text examples no longer silently become
application/json. Conditional rules retain precedence over examples.

The editor supports body, status, literal header-object and delay changes while
preserving unedited IDs, schemas and extension metadata. Validation finishes
before replacing the example. Removing an example requires confirmation;
cancelling leaves it unchanged. Persistence still uses the normal project save.

A shared browser/server validator checks integer status, well-formed Unicode
body up to 8 MiB, delay 0–5000 ms, and a plain header object. Headers are limited
to 100 entries, 256-character names, 8 KiB values and 64 KiB total framing size.
Names are case-insensitively unique; field values reject controls and characters
outside the HTTP byte range. Content-Length, Transfer-Encoding, Connection,
Upgrade and Trailer remain server-controlled and cannot be supplied by examples
or rules. This is not a multi-value-header or arbitrary wire-response editor.

Following [HTTP semantics](https://www.rfc-editor.org/rfc/rfc9110.html),
informational 100–199 examples may be retained as documentation but cannot be a
standalone final Mock response. The server suppresses content for 204, 205 and
304; HEAD remains handled by the HTTP engine. Raw HTTP fixtures check 205 bytes
rather than relying on fetch, which can hide a forbidden response body.

Tests cover empty and XML bodies, actual headers, metadata-preserving edits,
invalid/cancelled edits, real response bytes and browser create/reopen/edit/
remove. No external service is contacted by these fixtures.
