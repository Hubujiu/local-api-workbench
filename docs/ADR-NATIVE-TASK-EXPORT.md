# Bounded API-local native task interchange

This independent adapter extends both native JSON and directory definition
exports with API-local `nativeTasks` version 1. It is stacked on a dependency-only
join of PR #14 (native export) and PR #27 (bounded waits, including extraction and
assertion dependencies), not the unrelated backend integration branch. The feature
PR targets that temporary join; it can target develop after its dependencies land.

## Representation and rejection boundary

`before` and `after` map to native `request.pre_tasks` and `request.post_tasks`.
The closed task shape is `{id,name,type,enabled,data}`. Ordered `customScript`,
`pickVars`, `assert` and `wait` use the existing bounded execution normalizer;
phase, extraction scopes, assertion data, exact script text and explicit flags
1/0/-1 remain data. Export does not run scripts, interpolate templates, coerce
waits, grant access or change execution budgets. Repeated task IDs are not deduped.
JSON retains existing task IDs; directory output retains its existing stable
API/phase/index namespacing. Imported copies do not alias the original project.

Reject database tasks, any origin (including request-local origin on an inherited
snapshot), inert task-source fields, mixed legacy/script-source representations,
missing task ID/name and non-Apipost dialect. Existing export guards still apply.
Empty or all-customScript canonical pipelines also reject: native import would
classify them as legacy script sources rather than `nativeTasks`. No private
marker or synthetic wait is inserted to change that classification. Legacy
`importedScriptTasks` exports retain their previous behavior. Each pure-script
phase inside a mixed request is preflighted by the existing import parser too:
its bounded provenance text and combined script length must fit without changing
source. Request-level hidden/inherited fields or accessors reject before reading
pipeline configuration, including direct non-JSON callers.

Frozen plan steps containing `nativeTasks` reject explicitly, even empty or
entirely disabled pipelines. Native flow API source is inert and is not the
frozen step's executable pipeline. This guard prevents the directory serializer
from overwriting canonical tasks with an empty legacy-source list. Existing
`importedNativeTaskSource` remains rejected; this slice does not expand its schema.
Full Workbench backup remains the preservation path for unsupported definitions.

## Independent evidence, not original-runtime parity

Static schema observations come from the already lawfully obtained Offline2
artifacts: sender module 842216 and work module 526737 (task import), 258928
(definition export), plus the task editor defaults. Only format/behavior facts
were used; no proprietary code, private archive or runtime-generated fixture is
included. Sender uses pre/post ordered tasks, scalar millisecond wait data and
`tempVars`/`envVars`/`globalVars` extraction scopes. Native import regenerates task
IDs, so original-app roundtrip ID stability is **not** claimed. See existing
extraction/assertion/wait ADRs for strict bounded differences from the sender.

Acceptance uses independently authored fixtures and real loopback HTTP through
public import, execute, both native exports, reimport, backup restore and restart.
It checks fresh login-to-Bearer values, all three extraction scopes, same-phase
lexical bindings across waits, disabled literal templates, response definitions,
source immutability, project/environment isolation and atomic rejection. These
are Workbench definition/execution roundtrips; no new original GUI or license
verification was performed. PR #14's historical Basic/form GUI verification does
not establish native-task GUI compatibility. Original execution policies for
wait scheduling, extraction failures or assertion errors are not encoded by the
native file and are not promised equivalent.
