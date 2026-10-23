# Modern Header / Query shortcut methods

Static primary reference: the official Offline2 2.0.0 send.asar/index.js embedded
pmapi setup at decoded character offset 28735174 exposes setRequestQuery,
removeRequestQuery, setRequestHeader and removeRequestHeader. Setters explicitly
use String(value). The outer compatibility layer aliases apt to pm. Provenance
and static-only inspection constraints are in ORIGINAL-OFFLINE2-RESEARCH.md.

The four methods now exist on pm. In the apipost8 dialect, apt uses those same
methods, including String(null) = "null" and String(false) = "false". Legacy apt
retains its earlier null-to-empty contract rather than silently changing old
projects. Both reuse the existing bounded request mutation implementation:
header names match case-insensitively, query names match exactly, and setting or
removing a query removes its matching literal URL occurrences while retaining
other query values and the fragment. Existing same-name rows are canonicalized
by the prior implementation; this is not a full duplicate-preserving vendor
PropertyList or URL SDK. Invalid/reserved names remain rejected.

No new HTTP, credential, filesystem or module authority is introduced. Mutations
remain per-execution copies and do not rewrite saved request definitions. The
modern setRequestBody helper is deliberately not claimed here: its vendor
raw/form/path semantics differ from the existing legacy helper. Use the already
supported pm.request.body.update and form collection APIs for that contract.

Tests cover both dialects, scalar stringification, removals and a real HTTP
request with unchanged saved plan. Browser coverage sends actual modified
headers/query fields; desktop packages exercise the API methods in the bundled
VM. Exact-head CI is required before claiming those browser/package checks.
