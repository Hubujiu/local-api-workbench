# Import materializes the selected OpenAPI server defaults

OpenAPI 3.0.3 [Server Variable Object](https://spec.openapis.org/oas/v3.0.3.html#server-variable-object)
requires a string `default` and uses it when no alternative is supplied. Previously
`https://example.test/{version}` was imported literally, so execution and cURL sent
`%7Bversion%7D` rather than the declared default.

The importer now selects the first server at the operation, path, then root level
(empty arrays continue to the next level), then substitutes its defaults in one
pass **before** appending the operation path. It does not change `{id}` path
parameters, evaluate scripts, fetch references, alter environment/global scopes,
or mutate the source document. An overridden server and unselected alternatives
are not expanded. No-server and Swagger host/scheme/basePath fallbacks remain.

Empty string defaults are valid; numbers, booleans, null and missing defaults are
not coerced. Definitions and defaults require own properties; names such as
`__proto__` are ordinary map keys, never object mutations. Callback replacement
preserves `$&`, `` $` ``, `$'`, slashes, colons and encoded bytes without treating
defaults as replacement instructions or applying `encodeURIComponent` wholesale.
URL parsing may normalize Unicode and spaces as it already does for execution.

## Explicit bounds and compatibility

- Selected URLs and defaults are at most 64 KiB; expanded URLs are at most 64 KiB,
  with at most 1000 definitions and 1000 placeholder occurrences.
- A single leading workbench `{{baseURL}}` token remains opaque and may coexist
  with OpenAPI `{version}` tokens. Its name may itself contain `?`; this is not a
  URL query. A same-named OpenAPI definition is ambiguous and rejected. Runtime
  templates elsewhere in a server URL are still preserved on import, but their
  OpenAPI export fails explicitly rather than losing part of the target.
  Malformed/nested braces and defaults containing literal or percent-encoded
  braces are rejected, not recursively expanded or reinterpreted as path/runtime
  variables.
- Substitution must produce an absolute HTTP(S) URL or retain a workbench
  template. A relative server template needs a source-origin resolution policy
  that this importer does not have and fails explicitly; existing untemplated
  relative URL handling is unchanged. Query/fragment-bearing server
  bases, controls, literal backslashes and malformed percent escapes also fail
  explicitly, including previously accepted non-template servers. The previous
  plain concatenation was not correct support for these cases. Use operation
  query parameters or an explicit executable server base instead.

The saved executable URL is materialized. OpenAPI export uses its actual origin
and path; for legacy prefix URLs, export retains that exact prefix as the
operation server and keeps the materialized path in `paths`, avoiding duplicate
base paths on reimport. Native backup preserves the saved request. This is **not**
a server-variable editor or full server metadata roundtrip: alternate servers,
enum choices, descriptions and original templating are not an executable
configuration, and export does not promise to retain them. Existing operation
metadata may remain in a native backup but never overrides the saved URL.

Conversion completes before project mutation. Tests cover source/scope isolation,
precedence, literal defaults, own-property boundaries, legacy mixed-template
roundtrips, rejection/limits, atomic mixed-import failures (also MCP sync), and
real loopback HTTP import/execution → Store/app restart → OpenAPI reimport → native
backup/restore. No original client execution, new UI, external services or script
sandbox behavior is involved.
