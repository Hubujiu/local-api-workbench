# Single modern script-task import

Modern exchange envelopes previously rejected every nonempty task list. This
adapter now accepts exactly one enabled `customScript` task in each request's
`pre_tasks` or `post_tasks`, with string `id`, `name` and `data`, and `enabled: 1`.
The code is retained byte-for-byte as beforeScript/afterScript. Task ID and name
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

Multiple tasks, disabled tasks, mixed task types, unknown fields, nonstring code,
code above 64 KiB UTF-8 and inherited/global/folder tasks reject atomically.
There is no concatenation that might change lexical scope, ordering, await
semantics or per-task isolation. Legacy script fields still reject. Empty task
lists leave existing default dialect behavior unchanged.

Fixed tests use synthetic envelopes and owned loopback HTTP: exact code and
source preservation, zero requests during import, request-header mutation,
request-local variables across pre/post phases, parsed-response assertions and
failed assertion evidence. Invalid task/resource variants leave the destination
unchanged. Browser CI imports the synthetic pre/post tasks and checks a header
returned by the actual fixture server and a successful post-response assertion.
