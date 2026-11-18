# Native response definitions without sample bodies

## Problem and implementation

An imported API can have documented error schemas but no concrete response
examples. The native JSON/directory exporter formerly rejected that entire
project, although the established modern reader already distinguishes a missing
raw field (definition only) from raw:"" (an explicit empty response).

The exporter now emits an independently identified definition-only entry for
each supported status/media definition not covered by an existing example.
It retains the schema, description and media type, including references through
the existing model adapter. It does not invent a body, response headers, delay,
Mock activation or response-check activation. Existing examples, including
empty bodies, retain their ordering and bytes; unmatched definitions follow
them in their original definition order. This preserves response semantics,
not an independent presentation order between definitions and examples.

JSON, XML, HTML and text remain the only supported single-media definitions.
Descriptions must be nonblank and at most 200 characters because the native
reader otherwise substitutes a generated name. Boolean root schemas,
unsupported metadata, ambiguous definitions and inconsistent schema copies
still reject. The combined native list, not just each source array, is limited
to 100 entries. Nothing executes or fetches schema references during export.

## Evidence and limit

This uses the existing Workbench modern/native response reader contract in
apipost-modern.mjs and apipost-import.mjs. Synthetic fixtures exercise model
references, compositions, literal reference-shaped example data, mixed
definition-only and explicit-empty examples, both export formats, owner HTTP
authorization, import, persistence, restore and Store reopen. Source projects
remain unchanged. Two added regressions fail on the original explicit-body
guard before implementation.

This is a bounded interchange round trip, not a new original Apipost execution
capture or proof of arbitrary native file compatibility. It does not enable
nonempty automated_testings, remote references or complex proprietary model
composition.
