# Frozen native task provenance directory round trip

Native executions/flows imports retain API tasks as importedNativeTaskSource,
separate from executable per-step pre_script/post_script. Previously the
directory exporter refused every frozen step carrying this source, blocking
migration back even for ordinary local scripts, extraction, assertion and wait
records that both readers already understood.

The exporter now writes that bounded local mixed source back into the frozen
api_snapshot request only. It does not create live API resources, change enabled
flags, deduplicate task IDs, execute scripts, sleep or evaluate assertions. The
step's own scripts remain independent. The forward import must reproduce the
entire normalized inert source exactly or export fails.

Admission reuses the established task pipeline format validators without calling
the executor. Only explicit IDs/names, known local tasks and mixed task lists are
supported. Database source, inherited origins, simultaneous legacy script-source
fields, pure-script/empty mixed-source records and unrepresentable active
definitions still reject. Pure-script records need the existing
importedScriptTasks representation; export does not silently switch models.
Executable nativeTasks in a frozen step remain unsupported and rejected.

Synthetic tests include active source scripts that throw, an assertion requiring
status 599, extraction that must not write a variable and a disabled template
wait. The imported flow executes only its explicit step scripts through real
HTTP after two directory generations, owner export, restore and app restart.
Exact task identity/data/order persists, no live API appears, source variables
remain absent, and request/project inputs stay unchanged. Descriptor tests
ensure accessor definitions are not executed; readback rejects missing or
reordered source. Existing database-flow isolation and original flow tests
remain required regression coverage.

The established executions/flows semantics are documented in
ADR-OFFLINE2-EXECUTIONS.md. This increment adds no original application capture
and does not establish nonempty legacy automated_testings graph semantics,
database provenance rebinding or arbitrary native-project compatibility.
