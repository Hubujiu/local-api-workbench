# OpenAPI request-body media conversion

Request bodies no longer silently become empty JSON when the selected media type
is text/XML or a form. Import prefers an exact application/json entry, otherwise
the first declared media type. JSON-suffix types retain JSON values; text, XML,
XML-suffix and JavaScript types use raw string bodies. The selected Content-Type
is represented in request headers. Alternate media definitions remain in original
operation metadata but are not a live media-type selector.

URL-encoded and multipart forms support scalar fields with examples/defaults,
required flags and descriptions. Multipart binary/base64-schema fields become
file placeholders that require explicit selection; schema examples are never
interpreted as local paths or file bytes. Runtime constructs multipart boundaries.
Complex arrays/objects, custom field encodings and unsupported binary media fail
explicitly instead of silently producing incorrect JSON. External examples are
not downloaded. This bounded support is not full OpenAPI serialization parity.

Export now reconstructs these supported request-body types, preserving selected
media, scalar form schemas and file definitions without exporting file contents.
Duplicate form keys are rejected rather than collapsed. Tests verify import/export
round trips, real HTTP XML and URL-encoded bytes, and refusal of unselected files.

Reference: https://spec.openapis.org/oas/v3.1.0.html#media-type-object
