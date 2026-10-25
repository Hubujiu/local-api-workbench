# Active-project OpenAPI import backend

## Source and independent scope

The official synchronization documentation states that scheduled imports stop
when the client closes or the current project changes, and restart their timing
when reopened: https://wiki.apipost.cn/docs/project_set/import_project/synchronize/ .
Static inspection of the official Offline2 2.0.0 package independently found
main-process interval notifications consumed by a renderer Swagger conversion
and import path. That observation does not prove runtime equivalence. No original
source or binary is included here.

This backend implements an explicitly activated, single-project session. Saving
or restoring a configuration alone never starts network access. API clients must
activate a project and deactivate when they close/switch it; no new UI wiring is
part of this change. Server shutdown aborts in-flight work. Reopening starts a
fresh interval, with no catch-up storm. This is not all-project background sync.

## Supported contract

- Up to ten explicitly enabled HTTP(S) sources per project, intervals 60 seconds
  through 24 hours. URLs cannot contain credentials. Authenticated source feeds
  are not supported yet; no credentials are inherited from project requests.
- OpenAPI 3.0/3.1 JSON or YAML only. Reuse the existing bounded HTTP executor,
  YAML parser and stable-ID synchronization implementation. Remote references
  remain forbidden. Only URL, URL-and-folder and ignore-existing cover modes;
  clear-all and append-duplicates are intentionally unsupported for schedules.
- Run-now uses the same active-project and enabled-source checks as scheduled
  runs. One import at a time per service. Switching/deactivation aborts the old
  request; an old response must not mutate either project.
- Re-read the current project before commit. A changed source configuration,
  archived project, missing destination folder or concurrent save fails without
  overwriting unrelated edits. No automatic retry of uncertain writes.
- Persist bounded result history, not the fetched response or credentials.
  Ordinary project save/backup retains definitions; activation and timer state
  are process-local and never restored as authority to run.

## Acceptance

Use real local HTTP, real Store save/reload and the public HTTP API for source
configuration, activation, run-now, repeated stable IDs, invalid document
atomicity, disable/switch cancellation, restart inactivity and project isolation.
Use an injected clock only to verify scheduling boundaries without minute-long
sleeps; the scheduled callback must still perform a real HTTP request and save.
Existing backend/CLI/MCP and frontend regressions remain enabled. This is a
bounded compatibility subset, not complete native migration or all original
model/environment overwrite policies.

## Save boundary and APIs

`PUT /api/projects/:id/auto-imports` replaces the validated source definitions;
`GET` returns definitions, bounded saved runs and the process-local session.
`POST .../auto-import-session` explicitly activates or deactivates the project;
`POST .../auto-import-run` runs one enabled source by `sourceId`.
All routes retain the application's existing local-token requirement.

Cancellation is checked after acquiring the project save lock and immediately
before starting the atomic disk transaction. A queued save is cancellable; once
an atomic transaction has begun, deactivation waits for the operation to settle
rather than corrupting the transaction or pretending it was rolled back.
No future run is scheduled after deactivation/shutdown. An invalid active
project configuration stops the session with a bounded diagnostic; a remote
fetch/import failure is recorded and waits for the next normal interval.
