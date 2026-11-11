# Packaged Electron restart journey acceptance

Test-only candidate based on PR207. This is not a product lifecycle change or a
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

Local verification is limited to syntax, formatting and non-browser lifecycle/
receipt regression. The new packaged journey and extracted browser adapter still
require their own reviewed CI execution before claiming acceptance. It does not
cover installers, signing/notarization, crash/power-loss recovery, every provider
or arbitrary user projects. Existing shutdown cancellation/failure tests remain
independent and unchanged.
