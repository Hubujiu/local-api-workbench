# Exact editable Mock examples

A response example's explicit empty body remains empty; missing body metadata
still has the historical `{}` fallback. Literal response headers and a bounded
delay are now honored, so imported XML/text examples no longer silently become
application/json. Without an explicit example index, conditional rules retain precedence over examples.

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

## Explicit selection and debug transition

Each example has a direct debug action. A single canonical non-negative decimal
`example` query index selects that stored example before conditional rules. Bad,
fractional, negative, duplicate, out-of-range or malformed selections
return an error rather than a successful response for a different example.
Omitting the index retains the normal rule → first example → schema/default flow.
A null/malformed stored example is not replaced with a fabricated `{}`.

The debug action saves pending project edits before switching the request URL,
so newly edited examples exist on the Mock server. Concurrent saves, interface
switches or further edits stop the transition rather than modifying a different
request. Literal request query rows named `example` are retained but disabled
when a specific example is selected. Other global parameters and scripts remain
active; conflicting duplicate selectors are rejected by the server.

Mock URL path values are encoded and rendered as escaped attributes. Tests cover
selection precedence, malformed indices, actual HTTP errors, preserved query
metadata, pending-edit persistence and UI sending of a specifically selected
empty-body example.

Same-origin Mock also enforces server-owned isolation/browser-state headers, as
described in [Mock origin isolation](ADR-MOCK-ORIGIN-ISOLATION.md). Arbitrary
cookie-changing or executable-HTML responses are not supported on this origin.
