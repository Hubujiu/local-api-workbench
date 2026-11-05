# Empty JSON definition exports

Ordinary HTTP execution treats an exactly empty JSON body as `{}`. Literal
request export now applies that same fallback in the shared temporary preparation
used by cURL, Node, Python and Go. The normalized saved definition remains empty;
this is not a persistence migration or a change to runtime replay evidence.

Only `bodyType: json` with normalized `body === ""` receives the fallback.
Nonempty text is never parsed or reserialized by export, including whitespace,
duplicate JSON keys and large numbers. Whitespace-only JSON remains invalid in
ordinary execution; export still preserves it literally. Raw bodies are not
classified by Content-Type. In particular imported `curl --json ''` remains raw
and empty. None, URL-encoded and multipart behavior is unchanged. GET/HEAD code
examples remain rejected; cURL retains its existing explicit-method behavior.

Fixed loopback tests compare runtime with generated cURL, Node and Python, and Go
when a real Go toolchain is available. cURL wire execution requires a probed
POSIX `/bin/sh`; hosts without it skip only cURL execution, not other targets.
Assertions cover body bytes, method,
Content-Type and Content-Length. The existing body-less cURL POST omits
Content-Length while runtime sends zero; this client default is preserved and
asserted separately. Tests also cover inherited media types, environment values
resolving to empty text, no script execution, no request during generation, and
unchanged input/project state. A separate loopback probe confirms neither the
main request nor before/after scripts run during export. A positive control runs
the same authored fixture through `runPlan` and observes before/main/after calls.
No original program or external target is executed.

## Bounded Go build and execution evidence

The first Linux CI run killed its initial `go run` at the fixture's 60-second
limit. Later Go fixtures passed. Cold compilation is consistent with that
observation, but the original error lacked phase/signal evidence and does not
establish the cause. The test now separates build from execution without raising
limits: one build invocation has 60 seconds, each program execution has 60
seconds, and the complete wire test retains its 180-second limit. A timeout is a
failure, never a skip or a trigger for a warm-cache retry.

Each of eight fixtures has its own unmodified generated main package and binary.
A single bounded `go build` builds all eight packages; every binary is executed
once against its own loopback path. No shared substitute program represents the
other generated sources. Module/proxy/workspace/toolchain-download paths are
disabled for this standard-library build. Missing Go alone produces an explicit
skip. Local planner tests do not establish that Go compilation succeeds.

Test-only process diagnostics contain phase, fixture, exit code, signal, timeout,
abort and cleanup receipts, never source, command arguments or stderr. POSIX
termination targets the owned process group and checks for remaining live group
members. Windows uses a test-only Python ctypes Job Object owner. An extended startup
attribute atomically admits the suspended target into the job before its thread
resumes; a failed admission never creates an unowned suspended child. An explicit
handle allowlist excludes control/receipt pipes and the job handle. Normal parent
exit, timeout and abort all terminate remaining job members and require the OS
job's ActiveProcesses=0 receipt. Parent exit alone is never a cleanup receipt.
The job uses KILL_ON_JOB_CLOSE as a fallback, but a missing receipt still fails.
Admission failure and unconfirmed cleanup remain separate diagnostic fields.
The implementation requires Windows CI validation; local syntax/planner checks
cannot establish Windows Job Object behavior.
Synthetic timeout/abort fixtures verify a real descendant PID stops running and
its heartbeat stops. Non-running Linux zombies awaiting host reaping are reported
as non-running, not as nonexistent PIDs. Active cleanup is awaited before removing
temporary files. Unique per-fixture/target request identities prevent late or
duplicate requests from being consumed as another fixture's evidence.
