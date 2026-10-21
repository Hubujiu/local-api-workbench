# Explicit SQLite DML

Status: implemented; see the current commit's CI for verification. This is a bounded subset, not full Offline2 database compatibility.

## Contract

Database requests remain read-only unless `allowWrite: true` is explicitly supplied. The UI requires a per-operation checkbox and a confirmation containing the file and SQL, and resets the checkbox after cancellation or completion. The authenticated loopback API also checks the existing token/origin boundary. No MCP or pre/post-script database capability is added.

Only existing SQLite files and one INSERT, UPDATE or DELETE statement are accepted. Positional JSON-array bindings and RETURNING are supported. Quoted semicolons and trailing comments are not mistaken for a second statement. DDL, ATTACH, PRAGMA, explicit transaction control, WITH-prefixed writes, REPLACE and OR REPLACE are rejected. Other database providers remain read-only.

A BEGIN IMMEDIATE transaction wraps execution. More than 1000 SQLite `total_changes()` counted changes, more than 1000 RETURNING rows, or more than 1 MiB serialized RETURNING values cause rollback before commit. BLOB return values use explicit base64 objects. The change count includes ordinary trigger changes but is SQLite accounting, not a universal bound on affected storage: schema-defined conflict replacement, virtual-table internals and native database function side effects are not fully represented. Only use trusted databases; back up first. The limit is checked after execution, not a pre-execution work estimate.

The worker has a 64 MiB JavaScript old-generation limit and a 2 second termination request. Native SQLite work/memory is not comprehensively limited by the JavaScript heap cap, and native calls may delay worker termination. A timeout/crash without a confirmed result is reported as an uncertain outcome, never as a guaranteed rollback. Inspect the database before retrying; no automatic retries are performed. A confirmed commit is reported only after the worker exits.

## Evidence

`tests/database.test.mjs`: default read-only rejection, opt-in HTTP authentication/origin/type boundary, parameter binding, real temporary-file insert/update/delete with RETURNING, delimiter handling, forbidden statements, transaction rollback of excessive changes and trigger effects, oversized output rollback.

`tests/ui-smoke.mjs`: real temporary SQLite file, default write rejection, confirmation cancellation without mutation, explicit successful insert and checkbox reset; screenshot `local-api-sqlite-write.png` in the browser evidence artifact.

No user database, external credentials or production service is used in these tests. No claim is made for remote SQL writes, multi-statement editing, database pre/post hooks or full vendor parity.
