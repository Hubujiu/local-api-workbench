# Literal URL query parameters in OpenAPI definitions

The previous exporter derived a path from the URL but emitted parameters only
from the separate Query table. A request such as `/items?q=one&empty=` therefore
lost both URL query parameters. Export now projects static URL query pairs before
active Query table rows, without mutating the saved request. Query and fragment
syntax is also removed before deriving relative or templated-base paths.

URL query values are decoded as scalar string examples using form-style query
semantics. Empty values with an explicit equals sign are preserved with `allowEmptyValue`
set explicitly; this boolean metadata survives export/reimport without coercion. Disabled
Query table rows remain excluded. This exports logical API parameter definitions,
not exact URI byte spelling: `%20` and `+`, or percent-escape letter case, may be
normalized on reimport. Use cURL or native project backup when exact request
encoding or signature input must be retained.

OpenAPI 3.0.3 identifies a parameter by its name and location and disallows
repeated parameter definitions in an operation. The exporter therefore rejects
duplicate query names, including collisions between URL and Query table fields,
instead of producing an invalid document or guessing an array schema. It also
rejects raw flag parameters without `=`, empty raw names, malformed encoding and
unresolved raw-URL template expressions, and decoded template-like literals that
would be reinterpreted by the workbench variable syntax, rather than silently dropping or
reinterpreting them. Existing SDK URL mode and empty-equals-policy restrictions
remain in force; this change does not enable SDK-mode OpenAPI export.

Source: https://spec.openapis.org/oas/v3.0.3.html#parameter-object

The parser reuses the existing token-aware URL splitter. Raw query processing is
bounded to 64 KiB and 1000 segments. It invokes no variable provider, user script
or external reference. Tests cover scalar examples, empty values, relative and
templated-base paths, disabled rows, duplicate/unsupported input rejection,
source immutability, and real HTTP comparison of decoded parameter values after
export/reimport. A browser fixture checks the actual downloaded OpenAPI JSON.
