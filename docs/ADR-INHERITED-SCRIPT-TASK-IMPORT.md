# Flatten inherited custom-script tasks on modern project import

Static inspection of the official offline 2.0.0 request adapter shows ancestor
custom-script task arrays accumulated from the project through ancestor folders,
then followed by request-local tasks. Enabled custom-script blocks are assembled
in a single phase program. This applies to both pre-request and response phases;
it is not the reverse-order teardown model used by some other frameworks.

The modern JSON importer now accepts this bounded custom-script-only case. It
flattens each request's effective task lists into an import-time execution
snapshot, in project-to-leaf order. It retains disabled source without executing
it. Each task in an inherited snapshot receives an inert origin descriptor
(scope and original resource ID), shown in the readonly source viewer and
preserved by native backup. Request-only imports without inheritance retain
existing metadata exactly. Import itself never executes scripts.

This is not a live folder-script editor or a lossless native Apipost project
roundtrip. Later folder edits do not regenerate the flattened program. Import
notes explicitly disclose this limitation. A folder with tasks but no descendant
API, or a project with tasks but no APIs, is rejected rather than losing its
source. Mixed database/wait/assertion task types, legacy script fields, unknown
states and unsupported source metadata remain rejected atomically. Input task
objects cannot supply their own origin descriptors; those are derived locally.

The effective combined phase, not each ancestor separately, remains limited to
16 tasks and 64 KiB of original source. Existing compiled-source, provenance,
serialized-output, QuickJS activity and total-time limits remain unchanged.
Origins use closed descriptor-checked data, never accessors or executable hooks.

Regression tests cover both phases' lexical ordering over real HTTP, disabled
source, source immutability, native backup, aggregate limits, orphan sources,
unsupported inherited tasks and escaped readonly rendering. The browser import
fixture references variables declared in project and folder tasks, then checks
the request header received by its independent HTTP fixture.

Static source: official Apipost offline 2.0.0 Linux package, SHA-256
`7c66b8963960dd22a384072ecb714c9d8ba1164bb2ecd8f2d90d325fa3d83942`,
request adapter module 842216. Only static source was inspected; this is not an
original-runtime GUI execution comparison.
