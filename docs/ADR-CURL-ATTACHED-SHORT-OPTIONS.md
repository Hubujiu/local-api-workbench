# Restricted attached cURL short-option values

## Scope

The existing literal cURL importer now accepts attached values for exactly three already-supported options: `-XPOST`, `-H'Content-Type: application/json'`, and `-d'{"x":1}'`. This is the short-option argument form described in the [curl option documentation](https://everything.curl.dev/cmdline/options/index.html).

Only an option-position token is split into its two-character option and remaining value. Already-consumed values are never split, including a body beginning `-H` or `-d`. After splitting, the existing method/header/body parser supplies all behavior: last explicit method, ordered repeated headers, repeated data joining, default headers, `--get`, validation, and normalized request storage. Export can use the existing separated spelling; spelling is not preserved, request semantics are.

No shell is executed during import. File references, shell expansion/operators, unsupported options, incompatible body families, and ambiguous repeated empty data retain their existing refusals. This does not add option clusters, attached values for other short options, long `--option=value` forms, multipart support, new file access, authentication, network privileges, or budget changes. A quoted empty suffix produces no attached characters and remains governed by the existing literal tokenizer and separated-option behavior; this is not a general shell parser upgrade.

Owner direct cURL import is supported. MCP can execute the resulting stored request; its manual-import document workflow does not accept cURL text and remains explicitly unsupported. No new MCP importer is introduced.

## Verification

Synthetic fixtures compare attached and separated parsed definitions, including repeated methods/headers/data, quoting, backslashes, dollars, Unicode, newlines, and option-looking data. Fixed arguments are passed to the installed `curl` executable without a shell and only to a loopback receiver; the observed request is compared with imported execution and export/re-import execution. Dangerous source strings are parsed only and never executed. Workflow tests cover owner import, MCP execution, backup/restoration and restart, with unsupported imports leaving requests and network activity unchanged.

This is bounded compatibility with the existing importer, not support for arbitrary cURL command lines or every cURL version/platform option.
