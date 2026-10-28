# Postman structured URL import (bounded)

PR47 follow-up: a valid URL component object without `raw` previously imported
successfully but persisted an empty URL. A real owner import → restart → cURL
fixture failed with `400 Invalid URL` before this change.

Primary sources inspected (not copied):
- Official schema: https://github.com/postmanlabs/schemas/blob/c5fa20c6210207d09b06a23d700f9228c31ad703/schemas/draft-04/v2.1.0/collection/url.json
  (blob `3823b9d39ebdd49d8fbe176893d4eff30a7bc091`). `raw` is optional;
  host permits string/string array, path permits string/segment array, port and
  hash are strings. The schema website itself could not be retrieved.
- Official SDK: https://github.com/postmanlabs/postman-collection/blob/4ae76c15974011ea67b13c1895c4a02f4cbd3746/lib/collection/url.js
  `update(object)` reads components, `toString()` serializes them. License at
  the same commit's LICENSE.md is Apache-2.0. No SDK implementation is copied.

An original small formatter preserves raw-string precedence (including explicit
empty raw drafts), joins host strings with dots and path segments with slashes,
retains percent escapes and fragment text, and keeps query/path-variable rows in
our existing separate model. Query order, repeats and disabled rows are retained.
Existing empty URL drafts remain valid. HTTP/HTTPS schemes are explicit; a host
consisting solely of a base-URL variable may supply its scheme at execution.
Host-only URLs without a scheme are rejected, not silently assigned HTTP.

This is NOT all schema/SDK URL behavior. Path-object segments, component delimiter
ambiguity, embedded credentials, non-string component values and unsupported
schemes fail before persistence. Raw URL definitions retain their existing import
contract; component fallback is only for missing raw. Query values and fragment
are not interpreted as script. No VM execution or frontend changes.

Mature reuse assessment: postman-url-encoder 3.0.8 accepts a string or a real SDK
Url, not a plain JSON object; a fake SDK-shaped wrapper would be inappropriate.
The PR47 baseline has no such production dependency. This bounded formatter adds
no dependency and does not claim to replace the full Postman SDK.

Initial targeted validation: existing shorthand workflows and new structured
owner workflow pass, including restart, imported environment host/port, real GET
with Bearer authentication, repeated/disabled query, path variable, encoded slash,
frozen plan backup/restore and CLI persistence. Broader boundary and MCP checks
remain work in progress until separately recorded.

## Boundary follow-up

The same fixture exposed a second real RED: query-row replacement truncated a
fragment containing `?`. Raw URL import also applied `/:id` replacement inside
query and fragment text. The lexical raw formatter now separates fragment first,
then the actual query, and only transforms the path prefix. Structured component
URLs never have an embedded query to strip. This preserves raw precedence while
correcting text corruption; `%23` is not treated as a fragment delimiter.

Final targeted local batch: 30 tests pass (core plus shorthand and structured URL
files). Both raw/component owner workflows run real HTTP, persist and restart,
select imported variable environments, preserve `/ :`-like query text as the
literal value `/:keep`, skip disabled query rows, never transmit fragments, and
execute frozen restored plans through CLI. Actual official MCP SDK HTTP and stdio
read back stored request and CLI run objects exactly; another project is denied
by the read-only grant. Fifteen malformed/unsupported component variants in mixed
valid+invalid imports leave the entire project unchanged. Static checks cover
bracketed IPv6, ports, repeated/trailing slash, `%2F`/`%23`, empty and delimiter-rich
fragments, empty drafts and raw precedence. IPv6 coverage here is serialization,
not a claim of an IPv6 listener or external network execution. No whole-project
or cross-OS acceptance is claimed from this targeted local result.
