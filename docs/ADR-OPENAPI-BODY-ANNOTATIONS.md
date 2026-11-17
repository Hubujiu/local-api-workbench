# Preserve OpenAPI request-body annotations

The original operation is already retained on imported requests, but rebuilding
request-body media during export discarded its body-level annotations.

Export now copies only `required`, `description`, and specification-extension
keys beginning with `x-` from the retained body, then generates media content
from the current request. Values are cloned: exported extension objects cannot
mutate stored definitions. Explicit false, empty descriptions, and null extension
values remain intact. Absent annotations are not fabricated. Setting body type
to `none` still removes the entire exported request body, including old metadata.

Import/export reject nonboolean `required` and nonstring `description` rather
than coercing them. These are document annotations, not a new prohibition on
sending deliberately incomplete requests during debugging. Local body references
use the existing reference resolver; this change does not fetch external URLs.

The field types and extension support follow the
[OpenAPI 3.1 Request Body Object](https://spec.openapis.org/oas/v3.1.0.html#request-body-object).

Tests first reproduce the loss, then cover JSON, text, URL-encoded and multipart
bodies, local references, false/empty/null values, clone isolation, removal and
malformed annotations. This narrow fix does not establish lossless round trips
for all media alternatives, complex form encodings, or every schema feature.
