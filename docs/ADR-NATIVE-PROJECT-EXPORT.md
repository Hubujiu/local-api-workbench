# Native project definition export (work in progress)

Independent backend JSON exporter, exposed by GET /api/projects/:id/export?format=apipost.
It follows the observed Offline2 export envelope, not proprietary implementation.
The official UI selects APIs, models and environments; this first implementation
only supports bounded HTTP definitions, nested folders, environments/global
variables and service bindings, basic/bearer/API-key authentication and native
custom-script source. It never executes scripts, opens local files or grants a
database connection. It depends on PR #5's native mirrored-query import fix for
Workbench re-import, so its draft PR targets that branch rather than including
unrelated feature changes.

The output is a definition interchange, not an execution backup. Runtime history
and permission grants are not exported. Unsupported plans, protocol resources,
models, examples, inherited settings, database tasks and signing-auth types fail
explicitly; the existing full project backup remains available. No incomplete
output is returned after an unsupported dependency. Private source archives or
vendor code are not included. Explicit export can contain the project's saved
HTTP credentials and variable values, just as the existing project backup does;
the exporter does not fetch runtime-only credentials.

Local acceptance currently covers native JSON re-import, storage/reload,
restored-project isolation, repeated query rows, raw URL query, disabled rows,
body/header/auth output and initial/current environment values using actual HTTP.
Atomic rejection and input immutability are covered. Original-application import
and exact-head CI are still pending. This is not native-format parity or complete
project delivery, and remains draft until those boundaries are verified.
