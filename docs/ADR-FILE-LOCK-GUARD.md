# Cross-process lock recovery guard

Project, registry and cookie locks now hold a Node built-in SQLite `BEGIN IMMEDIATE`
transaction on a permanent sibling `<lock-directory>.guard.sqlite`. The transaction
covers legacy receipt inspection, dead-owner recovery, receipt creation, the entire
caller critical section and receipt removal. The OS releases the guard if a process
crashes. Store data remains JSON; the guard stores no project or cookie contents.
No package or native extension is added.

## Why

Two independent processes could both confirm a dead owner before either removed its
lock directory. The second recursive removal could then delete the first process's
new, live lock. A real two-process fixture reproduced two successful read-modify-write
operations persisting only one increment. Rechecking the nonce again would only move
the race. The original failing fixture is preserved in the regression commit.

SQLite supplies the cross-process exclusion around that legacy protocol. Its busy
timeout is zero so waits remain asynchronous and cancellable. Only SQLite BUSY result
codes are retried. Guard waiting and legacy-owner waiting share the same monotonic
2-second idle and 10-second hard budgets. Observed live-owner changes can extend the
idle budget, never the hard budget. Live or unrecognized legacy receipts are not
stolen. Abort, deadline and failure paths roll back and close the guard connection.
Parent directories are resolved before entering the local queue so symlink aliases
cannot bypass same-process serialization.

## Upgrade and operational limits

- Stop **all old application/CLI/MCP instances** sharing the data directory before
  upgrading. Old binaries do not acquire this guard. Concurrent old/new writers
  are not supported, even though existing `owner.json` receipts remain recognized.
- Keep guard files permanently, including while the application is idle. Never
  unlink, rename, replace, clean up or open/close them through unrelated file I/O
  while any instance may use that data directory. SQLite OS locks depend on stable
  file identity; on POSIX a separate raw file-descriptor close can release locks.
- Use local filesystems with working SQLite OS locking. Network/shared filesystem
  locking and concurrent external edits to application storage are not supported.
- A crash during legacy receipt initialization can still leave an incomplete
  receipt. It fails closed rather than guessing that an unknown owner is dead.
- This does not change JSON atomic-write/durability guarantees or provide an
  automatic repair tool for malformed locks or corrupt guard files.

## References

- [SQLite locking and rollback](https://www.sqlite.org/lockingv3.html)
- [SQLite file identity and POSIX descriptor hazards](https://www.sqlite.org/howtocorrupt.html)
- [Node 24 SQLite API](https://github.com/nodejs/node/blob/v24.22.1/doc/api/sqlite.md)
- [SQLite result codes](https://www.sqlite.org/rescode.html)

Tests exercise real child processes, crashed owners, persistent updates after
restart, a positive SQLITE_BUSY observation during the former recovery interleaving,
parent aliases, independent lock paths and cancellation. Fault injection is limited
to exact error/cancellation boundaries; it does not replace successful filesystem or
SQLite operations. Linux runs are local evidence; Windows/macOS and Electron runtime
coverage remain the responsibility of their CI jobs.
