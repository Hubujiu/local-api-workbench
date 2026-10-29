# Explicit multipart part media types

Status: frozen contract, implementation and CI acceptance pending.

Feature branch `feat/multipart-part-media-types` starts at develop
`88f70bb515c48b93536b28b7fe3ec780f2e150f3`. This is independent of PR51's
Postman mode/GraphQL import changes. Integration must preserve those changes.

## Defect and contract

The public Postman v2.1 schema permits `contentType` on text and file formdata
entries (https://schema.postman.com/collection/json/v2.1.0/draft-07/collection.json).
The importer discarded this field and the sender emitted no text-part media and
always application/octet-stream for files. An explicit JSON metadata part thus
silently changed meaning.

Canonical multipart rows may carry optional, literal `contentType`. Validate with
the existing MIT jshttp/content-type 1.0.5 parser, promoted from the lockfile's
existing development dependency to a direct runtime dependency. No new package
bytes or custom general MIME parser are needed. Preserve the original valid ASCII
header bytes, including case and parameters; reject empty/non-string/over-1024-byte
values, controls, wildcard media and variable templates. Explicit metadata is
only valid for form-data. Omitted properties remain omitted: old hashes and wire
defaults do not change. Validation applies before any network activity, including
restored/frozen/direct requests and disabled rows. Disabled entire Postman bodies
continue to ignore inactive body data when composed with PR51.

The sender uses the explicit type for enabled text/file parts. File selection
remains explicit and `requiresFile` is not cleared by import; source paths are
never read. Existing request/body limits, authentication, cancellation, persistence
and script budgets remain unchanged. Script text updates preserve existing row
metadata through the existing previous-row copy; no new VM API is added.

OpenAPI and cURL export explicitly reject this metadata until a separately
verified equivalent exporter exists. Native export keeps its existing refusal.
Project backups are the lossless interchange. No native-format equivalence, MIME
sniffing, body conversion, external resources, arbitrary part headers or frontend
controls are added.

## Acceptance gate

Pure validation checks and syntax/format are permitted locally. Actual application,
network, SDK, CLI and restart workflows run only in ordinary push CI. A real
multipart receiver must verify complete part header/body bytes for explicit JSON
text, a selected binary file, omitted defaults, duplicate keys and disabled parts.
Owner import/save, HTTP and stdio SDK execution, frozen CLI runs, later live edits,
backup/restore and fresh restart must preserve the media and independent snapshots.
Invalid media, mixed imports, unsupported exports and missing selected files must
leave state unchanged and send no requests; another project must remain unchanged.
Safety checks and limits are retained. Until exact-commit CI is inspected this is
work in progress, not delivery acceptance.
