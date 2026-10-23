# Root-level modern sample import

The original modern export has a separate samples array. Root samples reference
an API by target_id and use sample_id for their own identity. Static original
collection assembly maps these records to sample nodes; the request adapter's
root-sample branch starts ancestor lookup from the API parent context, excluding
the API's own request configuration. Project and ancestor-folder configuration
still applies. Sample groups introduce additional ancestry that is not covered
by this implementation.

Import now supports complete, root-level HTTP samples as independent local
interface cases linked to the newly imported API ID. Samples do not appear as
extra ordinary API definitions. Their own request and response definitions pass
through the same bounded modern conversion as APIs, including model references,
parameter/cookie semantics and custom-script validation. Project/folder scripts
and parameters become import-time snapshots; the source API's own scripts and
parameters are not executed or inherited. Inert task provenance identifies the
sample rather than a temporary conversion node.

Service snapshot flags freeze the selected binding, not the environment's base
address. An explicit serviceId is still resolved through the selected environment
at execution. Actual HTTP tests verify two environment addresses and variable
values without changing the case definition. Relative samples are currently
accepted only with one explicit default service (source ID 1) and no unsupported
folder service override. This conservative restriction avoids guessing service
selection in multi-service exports. Absolute or complete variable-based URLs use
the existing request resolver and validation.

Groups/nested samples, unsupported resource types, incomplete requests, unknown
fields, missing API links and ambiguous relative services fail the whole import.
Imported case IDs are stable and project-namespaced; a reimport collision is
rejected before appending APIs or metadata. Cases are bounded to 1000 after merge.
All case snapshots and their API IDs are prepared before mutation. Import and
restore never execute scripts. Source custom functions and mixed task types
remain unsupported. Automated testing trees are not enabled by this change.

Tests cover independent linkage, two real environment endpoints, lexical ancestor
script order, exclusion of origin-API scripts, atomic rejection, HTTP import,
restart, explicit execution and local backup restoration. Browser coverage imports
and runs a root sample from its source API and checks actual request data and the
sample assertion result, then restores its case linkage with the project backup.
This is a bounded JSON interoperability feature, not full original native project
or nested sample/automation migration.

Static sources: official offline 2.0.0 Linux package SHA-256
`7c66b8963960dd22a384072ecb714c9d8ba1164bb2ecd8f2d90d325fa3d83942`;
work index `index-0d1d8198fa5a.js` module 526737 (sample mapper) and collection
assembly; send adapter module 842216 (sample ancestor lookup). No original GUI
execution is claimed.
