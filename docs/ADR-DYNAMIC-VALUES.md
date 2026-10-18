# Dynamic parameter values

Official source: https://wiki.apipost.cn/docs/value/dynamicvalue/

Implementation contract:
- A parameter row may carry dynamic metadata: source variable or fixed, value, ordered function names. Variable lookup uses the effective values after the pre-request script, including request-local values.
- Values are typed JSON internally. Strings remain strings; objects/arrays become JSON text for wire fields. Function names reference the snapshotted project library, never executable expressions in a placeholder.
- Disabled rows do not evaluate. File uploads cannot carry text transforms. Missing variables/functions, invalid output and exceeded limits fail the step before network I/O.
- At most100 dynamic rows per request,10 transforms per row,64KiB each result. Functions run in bounded QuickJS and cannot write persistent scopes through this isolated preview path.
- Resolve ordinary interpolation separately from dynamic definitions, then assign dynamic outputs without a second interpolation. A literal "{{name}}" returned by a transform must remain literal.
- Preview is advisory; sending recomputes against the current post-script variables. Saved plans retain both metadata and function bodies.
- This first implementation covers fixed values and variables on query/header/path/cookie/form rows. Raw body insertion and Faker/Mock source selection remain separate unfinished scope.
