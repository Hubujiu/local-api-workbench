# Packaged Electron restart journey acceptance

Test-only journey introduced by PR208 on top of PR207. This is not a product lifecycle change or a
new license acceptance. It uses the existing packaged executable in each desktop
CI job (Windows, macOS, Linux/Xvfb), not a development Electron entrypoint.

`tests/helpers/restart-journey-ui.mjs` contains the same UI actions and assertions
previously run by the PR206 Chromium/service-process journey. Both host adapters
use it. The new desktop adapter supplies two real Electron launches sharing one
fresh temporary userData directory. HTTP and SQLite targets contain only synthetic
local fixture data; it neither reads user projects nor opens external services.

The journey imports, edits authentication/assertions, executes, grants SQLite,
extracts a database value into an HTTP request, creates a frozen plan, exports a
backup, restarts, views original history, restores a copy, views restored history,
verifies stale authorization cannot send HTTP, regrants/rebinds and executes.
Viewing history downloads and deep-compares the original record without replay.
Live rebinding must not rewrite frozen plan/history evidence.

Each successful Electron stop must use app.quit, produce exit code 0 without a
signal, emit the existing SAVED receipt and close its process. Forced cleanup never
qualifies as a successful stop. The first stop is followed by an old-port check;
the second launch must have a different PID and token, reject the old token and
not replay requests. No dirty-state dialog is stubbed or dismissed; the journey
saves before quitting. Renderer sandbox/context isolation remain enabled.

The existing browser and desktop job budgets and preceding smoke assertions are
unchanged. Failure of an earlier step can skip this new test: a skipped journey is
not passing evidence. Per-generation traces and final/history screenshots go to
`dist/desktop-restart-evidence`, included in the existing always-upload metadata
artifact. These are synthetic test artifacts, not user data.

Initial local verification was limited to syntax, formatting and non-browser
lifecycle/receipt regression. That initial evidence did not establish packaged
journey acceptance; the subsequent exact CI results are recorded below. It does not
cover installers, signing/notarization, crash/power-loss recovery, every provider
or arbitrary user projects. Existing shutdown cancellation/failure tests remain
independent and unchanged.

## Verified CI checkpoint (2026-11-12)

PR210 head `adf8dbbf2efc35bf41128404cc7887f08cbade42`, tree
`4d8765ad4b2ea44b716d2ac98df1bf861918caff`, passed all 43 jobs in
[run 43148687129](https://github.com/Hubujiu/local-api-workbench/actions/runs/43148687129),
attempt 1. Windows job 130952481393, Linux job 130952481581 and macOS job
130952481681 each logged the exact BUILD_HEAD, both clean exits and
`PACKAGED_DESKTOP_RESTART_JOURNEY_PASS`. Both artifact-upload steps passed on each
platform. This verifies the scoped journey above, not signing, installers, all
providers, arbitrary projects or complete product delivery. The PR remains draft;
nothing was merged or deployed.

PR210 only adds explicit `acceptDownloads: true` to the test launch. PR209's
[original run 43147844278](https://github.com/Hubujiu/local-api-workbench/actions/runs/43147844278)
remains failed (40 successful jobs, three failed desktop jobs): all three stopped
while waiting for the backup download before their first restart. PR208's
[original run 43095668942](https://github.com/Hubujiu/local-api-workbench/actions/runs/43095668942)
was still queued with zero jobs during the 2026-11-12 06:05 UTC review. Neither
original run is reclassified by PR210's success. See the
[current checkpoint](BACKEND-CHECKPOINT-2026-10-25.md#2026-11-12-桌面重启旅程检查点)
for the stacked commits and remaining delivery boundaries.

## Separate hard-stop recovery journey

`node tests/desktop-restart-journey.mjs --crash` runs the same complete synthetic
journey using a fresh temporary data directory, but terminates the first packaged
Electron main process with an OS-level `SIGKILL` instead of calling `app.quit`.
The hard-stop receipt requires an accepted kill request, abnormal termination,
closed process streams and no shutdown-saved receipt. Before any subsequent save,
execute or backup restore, a read-only native export of the original project is
deep-compared with the pre-stop export (including requests, folders, plans,
environments, settings and history), so restoring an external backup cannot mask
persisted data loss. This assertion also strengthens the clean-exit journey.
Cleanup kills never satisfy
this assertion. The second launch must use a new process/token, reject the old
token, preserve the saved plan/history, discard temporary database grants, avoid
network replay, restore the exported backup and execute only after explicit
regrant/rebind. The second process still exits cleanly.

This is an additional required step on all three desktop CI platforms; the
original clean-exit journey and its stricter clean receipt are unchanged.
Evidence is separate under `dist/desktop-crash-evidence`. The new commit must pass
its own jobs before this hard-stop journey can be called verified.

Scope: the hard stop occurs after the UI has acknowledged saves and the backup
has completed. This does not establish recovery during an in-flight save/network
operation, renderer-only crashes, OS power loss, filesystem/hardware failure or
preservation of unsaved drafts. It complements, rather than replaces, the lower
level interrupted-transaction and locking tests.
