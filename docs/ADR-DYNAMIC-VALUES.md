# Dynamic parameter values

Official source: https://wiki.apipost.cn/docs/value/dynamicvalue/

Implementation contract:
- A parameter row may carry dynamic metadata: source variable or fixed, value, ordered function names. Variable lookup uses the effective values after the pre-request script, including request-local values.
- Values are typed JSON internally. Strings remain strings; objects/arrays become JSON text for wire fields. Function names reference the snapshotted project library, never executable expressions in a placeholder.
- Disabled rows do not evaluate. File uploads cannot carry text transforms. Missing variables/functions, invalid output and exceeded limits fail the step before network I/O.
- At most100 dynamic occurrences per request,10 transforms per value,20 total transform calls,64KiB each result. A5second aggregate budget is checked between bounded VM calls and before returning; each worker retains its own2second wall deadline. Functions cannot persist scope writes through this isolated path.
- Resolve ordinary interpolation separately from dynamic definitions, then assign dynamic outputs without a second interpolation. A literal "{{name}}" returned by a transform must remain literal.
- Preview is advisory; sending recomputes against the current post-script variables. Saved plans retain both metadata and function bodies.
- Fixed values and variables work on query/header/path/cookie/form rows and Raw Body named tokens. Body definitions are stored in bodyDynamic; token syntax is {{@value:ID}}. JSON output escapes strings and retains types; text output is literal. Newlines/quotes are not silently reinterpreted. Missing tokens fail; unused definitions remain for editing. Faker/Mock source selection remains unfinished.
