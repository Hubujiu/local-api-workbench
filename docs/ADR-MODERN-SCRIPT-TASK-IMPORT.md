# Ordered modern script-task import

Modern exchange envelopes previously rejected every nonempty task list. This
adapter now accepts up to 16 enabled `customScript` tasks in each request's
`pre_tasks` or `post_tasks`, with string `id`, `name` and `data`, and `enabled: 1`.
Single-block code is retained byte-for-byte as beforeScript/afterScript.
Multiple blocks follow the original request-local assembly behavior described
below. Task ID and name
are preserved in bounded import notes as provenance, not reusable executable
task identities. This is an explicit conversion, not a task-list roundtrip.

Primary ecosystem shape evidence at EchoAPI-Team/echoapi-for-vscode commit
bc8ecb58271ac7a8b0289fad2f0455745b4562f1:

- https://github.com/EchoAPI-Team/echoapi-for-vscode/blob/bc8ecb58271ac7a8b0289fad2f0455745b4562f1/src/types/apis/request.ts
  defines TaskBaseItem and pre/post arrays.
- https://github.com/EchoAPI-Team/echoapi-for-vscode/blob/bc8ecb58271ac7a8b0289fad2f0455745b4562f1/src/constants/apis/index.ts
  names customScript, wait, database and other task types.
- https://github.com/EchoAPI-Team/echoapi-for-vscode/blob/bc8ecb58271ac7a8b0289fad2f0455745b4562f1/src/components/business/Request/TaskComponents/CustomScript/index.tsx
  binds the script editor directly to task.data.

These sources establish a modern ecosystem field subset, not successful original
Offline2 GUI execution or proof that its complete SDK and inherited task ordering
are equivalent. Imported requests explicitly select the existing apipost8 subset
and display that compatibility warning. No host API, arbitrary npm loading,
network permission, VM limit or execution budget is expanded. Import itself
never evaluates a script; user-triggered execution uses the normal pipeline.

Disabled tasks, mixed task types, unknown fields, nonstring code, more than 16
blocks per phase, code above 64 KiB UTF-8 per assembled phase and
inherited/global/folder tasks reject atomically. Task identity/name provenance
must fit 1800 characters per phase, so normalization cannot truncate it from
import notes. Legacy script fields still reject. Empty task
lists and previously accepted empty placeholders (null, empty string/object)
leave existing default dialect behavior unchanged.

Fixed tests use synthetic envelopes and owned loopback HTTP: exact code and
source preservation, zero requests during import, request-header mutation,
request-local variables across pre/post phases, parsed-response assertions and
failed assertion evidence. Invalid task/resource variants leave the destination
unchanged. Browser CI imports the synthetic pre/post tasks and checks a header
returned by the actual fixture server and a successful post-response assertion.

## Original request-local block ordering

The official Linux Offline2 2.0.0 package was downloaded again and its SHA-256
matched the already recorded 7c66b8963960dd22a384072ecb714c9d8ba1164bb2ecd8f2d90d325fa3d83942.
It was extracted only; no original application binary or bundled script ran.
Static send.asar/index.js at decoded character offset 33607709 iterates
pre_tasks/post_tasks in array order, accepts enabled customScript strings, skips
the literal sentinel `undefined`, trims each block and appends newline boundaries
to the same stage program. It does not wrap each custom block in a separate
lexical scope. Package provenance is in ORIGINAL-OFFLINE2-RESEARCH.md.

The multi-block conversion uses that observed request-local ordering and shared
scope rather than inventing separate evaluations or resetting the sandbox budget.
It does not infer global/folder ordering. First-block lexical declarations remain
visible to later blocks; awaited work completes before the following statement;
duplicate lexical declarations remain a stage error instead of becoming two
successful independent tasks. Newlines protect trailing line comments. Single
block compatibility is preserved. Original source code is not vendored.

Fixed evidence adds an actual child HTTP followed by the main HTTP, ordered
header assembly, shared post-script values, duplicate lexical declaration
failure before network, and aggregate UTF-8/provenance/count bounds. Browser CI
uses two pre and two post blocks and checks the echoed header and assertion.
