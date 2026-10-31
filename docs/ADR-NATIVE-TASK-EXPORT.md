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

## Explicit PostgreSQL/MySQL rebind profile (2026-10-31, WIP)

The default export still refuses a database directory or database pipeline.
Owner JSON/directory exports opt in with `databaseMode=rebind`; the direct
serializers accept `{databaseMode: "rebind"}`. This is a credential-free
connection-definition migration, not a backup of original connection settings.
No database session, grant or provider is inspected, refreshed or exported.

Only API-local PostgreSQL/MySQL tasks and their safe imported connection directory
are supported. Existing script/pickVars/assert/wait ordering remains intact.
Inherited task origins, frozen native-task steps, inert source mirrors, SSH
requirements, other database providers and write intentions remain unsupported.
The original task normalizer and driver read-only transactions remain in force;
SELECT/WITH prefix admission is not a new SQL semantic-purity proof. No runtime
budget, driver scope, grant or query policy is widened by serialization.

Output database IDs are stable hashes of current safe identities; task references
are remapped to them. MySQL result-set shape must match its provider before the
internal field is removed. Variable scopes map back to native names. Variable
row IDs are freshly generated deterministic UI identities; discarded original
param_id values are not claimed preserved. Optional finite safe-integer sort is
now accepted and retained by import; other sort shapes still fail before commit.

Every output connection has a documented empty host/user/password/database/
auth_source shell and disabled SSH with empty credentials. Port 5432 (PostgreSQL),
3306 (MySQL), and SSH 22 are profile-generated defaults, not recovered settings.
The intro explicitly warns that connection settings were omitted and reauthorization
is necessary. Workbench import keeps only safe identity/sort and requires a fresh
project-scoped ephemeral grant before execution. No claim is made that an original
Apipost runtime would safely reject an empty-host shell; do not run such a shell
there without deliberate configuration and authorization. Full Workbench backup
retains supported project state, not ephemeral grants or discarded credentials.

### Newly restored static evidence

Official Offline2 2.0.0 DEB re-downloaded 2026-10-31: 92,918,672 bytes, SHA256
`7c66b8963960dd22a384072ecb714c9d8ba1164bb2ecd8f2d90d325fa3d83942`.
Only archive data and plaintext were read; no installation, original execution,
compiled-code analysis, license acceptance or paid-check bypass occurred.
Renderer `index-0d1d8198fa5a.js`, SHA256
`20bb6e21fd678ead16bd91807dc9623b8cd3e7019d44ac874a167c31a37f39fb`:

- Module 258928, UTF-8 byte range [2778912,2780623): project exporter retains
  stored database links; it is not a credential-redaction facility.
- Module 526737, [3725436,3725746): database import maps identity and retains
  config/intro/sort, with absent sort defaulting to 0. This established that the
  old Workbench import whitelist incorrectly rejected the native sort field.
- Module 30695, [3521469,3521970): database-editor default configuration field
  shape and disabled-SSH empty credential fields. PostgreSQL 5432 is separately
  a UI port hint, not proof of automatic saved-config initialization.
- The variable UI rowKey uses param_id; sender extraction uses name/type/pattern.
  No proprietary implementation or native binary is included in this repository.

Acceptance requires two-format/two-generation semantic definition roundtrips,
source immutability and rejection atomicity, plus actual PostgreSQL/MySQL CI
services: import without grant refuses before HTTP, rebind then execute ordered
script/database/script/HTTP, no credential leakage, frozen backup/restart and
fresh authorization. Static syntax/model definitions alone are not acceptance.
