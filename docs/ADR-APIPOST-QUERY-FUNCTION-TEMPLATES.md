# Bounded exact-field Apipost function templates

Static inspection of the official offline 2.0.0 parser shows `$function.fn_name(raw text)` passing captured text as one argument, with case-insensitive registry lookup. Quotes and commas are not JavaScript or JSON argument syntax. Template-level synchronous exceptions preserve the expression, unlike the direct-script wrapper that returns its input text. The beforeRequest adapter then substitutes values into URL strings, header members, form members or raw body text.

## Supported locations and storage

Modern import accepts an exact single expression in an enabled API Query/Header/text-form value, or as the entire raw body of JSON/raw/plain/text source modes. Field names, embedded/nested expressions, unlisted built-in/argument-bearing pipelines, global/folder expression definitions and arbitrary sample expression locations are not claimed. Inherited copies into supported converted sample snapshots keep the explicit definition. Import never executes a function.

Internal sources are `apipost-function` (Query), `apipost-header-function` (Header), `apipost-form-function` (urlencoded/form-data text), and `apipost-body-function` (whole raw/JSON body). Source and position must match. Whole-body import uses one native body token and one definition with `format: text`; no prefix/suffix, extra dynamic body definitions, JSON-string wrapping or final-body override is accepted. Editors preserve the source and whole-body output mode. Changing modes cannot silently treat a file as dynamic text.

## Execution and bounds

Every stage requires exactly one matching imported function. An exact template may append up to nine no-argument custom `fn_` or whitelisted built-in stages; other pipeline forms and the separate native processing-chain field remain unsupported. Its body runs synchronously in the existing isolated QuickJS runtime, not in the host and not through the direct-script fallback wrapper. Timer, microtask and network allowances are zero. Finite primitive JSON outputs only; Promise, object, undefined, nonfinite values, excessive output and VM-budget failures remain errors. Syntax and unsupported host dependencies are not promised to match the original application runtime.

Existing code, memory and activity caps remain unchanged. Up to 20 transformations share the existing five-second aggregate deadline. Output and replacement expansion stay within 64 KiB serialized UTF-8. Requests cannot combine this source family with SDK URL mode, pre/post scripts or operations, unrelated native dynamic sources, or incompatible body modes. Validation precedes plan operations and is repeated during resolution. Disabled rows do not execute. Outputs are inserted after ordinary interpolation and are never interpreted as another variable or function template.

## Replacement and transport distinctions

The original replaces Query expressions within a URL string before rebuilding the SDK URL. Encoding every result as one local Query component is not proven equivalent. Query results containing URL structural/escape characters (`& # + % ? =`, CR/LF) or dollar substitution therefore reject, except an unchanged original-expression fallback is not new dollar substitution. Empty results with query_add_equal disabled also reject because the source placeholder initially emitted an equals sign.

For exact Header, text-form and whole-body fields, the original string replacement prefix and suffix are empty. Bounded replacement implements `$$`, `$&`, prefix and suffix tokens without recursive expansion; ordinary dollar text remains literal. Expansion is counted before constructing a large result. Header CR/LF is rejected. Form/body punctuation and line breaks remain ordinary payload data; existing urlencoded encoding and multipart framing are unchanged. This is not a claim of full URL-wire parity or arbitrary embedded-expression behavior.

## Migration and export safeguards

Native multipart file declarations use `field_type: File`, not just the legacy `type: file`. They become file-reselection metadata without reading source paths. Embedded file payloads, unsupported per-part Content-Type and inherited files reject rather than becoming text or disappearing. File expressions are not eligible for template conversion.

cURL/OpenAPI definition exports reject active templates instead of exporting empty values as equivalent requests. Backups and case/plan snapshots retain definitions and function libraries. Source project/function IDs are provenance, not a guarantee the body was never edited.

Independently authored tests cover raw quoted/comma arguments, case lookup, source-specific fallback, exact replacement and expansion limits, rejected asynchronous results, authority boundaries, passive/atomic import, file declarations, typed mode guards, actual HTTP, literal marker preservation and editor persistence. Browser fixtures exercise combined parameter modes, both form transports and whole JSON bodies against server echoes. Original GUI execution, genuine native-directory round trips, complete SDK/reflection behavior, other pipeline forms and untested signing interactions remain unverified.

## Exact custom-function pipelines

Static inspection of the same official 2.0.0 send module shows pipe stages receive the previous value, with a synchronous stage exception retaining that previous value. If the initial custom function throws, its fallback contains only the initial expression segment, not the appended pipeline. This differs from returning raw input text. Supported syntax is an initial `$function.fn_name(raw text)` followed by `|fn_other` stages without arguments. Unknown functions, variable/literal starts, unlisted built-in transforms, array/object outputs and embedded/nested templates are not silently accepted.

All stages run inside one existing isolated VM and share its unchanged activity/memory/total limits. Every intermediate must be a finite primitive within 64 KiB serialized UTF-8, checked using intrinsic serializer/character readers captured before user code; final output is revalidated by the host. At most ten stages per expression and twenty total request transformations are accepted. Timer, microtask and network allowances remain zero. Final transport replacement occurs once, after the full pipeline, and never feeds resulting template markers back through interpolation. Original host globals, reflection, arbitrary function interdependence and runtime GUI parity are not claimed.

### Primitive built-in stages

The source mapping directly assigns lodash `toLower`, `toUpper`, `size` and `toNumber` to `lower`, `upper`, `length` and `number`. These four no-argument stages are now whitelisted after the initial custom function. They use the already reviewed sandbox lodash library, with operations captured before custom code runs. Unicode string size and null/boolean/number conversions follow that library rather than replacing them with JavaScript `String` or UTF-16 `.length`. Nonfinite number results are still rejected by the existing primitive-result boundary. No new package, host module access, timer or network authority is introduced. Metadata supplied on user functions cannot classify them as trusted built-ins. Other names and all argument-bearing transforms remain unsupported.
