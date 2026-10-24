# Explicit bounded MySQL writes

The manual database HTTP endpoint accepts MySQL INSERT/UPDATE/DELETE only with allowWrite:true on that call and explicit host, database and user. Default queries, registered database sessions and script operations remain read-only. This is a backend addition; no new frontend controls are added.

Reuse mysql2 and the Apache-2.0 node-sql-parser 5.4.0 MySQL grammar. Parsing runs in a separate 128 MiB worker with a two-second deadline; it executes no SQL and exits before any database connection. Reject batches, non-DML, aliases/joined targets, external schemas, CTE/subqueries, INSERT SELECT/IGNORE/duplicate-key forms, comments and backslash syntax. Use bound parameters for data containing those characters. SQL is sent as the original single statement, not rewritten by a home-grown SQL generator. Input is capped at 50000 characters and the existing parameter limits; AST traversal has node/depth limits.

Each operation owns its data connection and a second cancellation connection with the same explicit target and credentials. Both may use the existing pinned SSH channel helper; there is no direct fallback. At most five writes are active. Connections are transient and destroyed at completion. The transaction first obtains a metadata lock with a zero-row target SELECT, then verifies an InnoDB base table through parameterized metadata lookup. This prevents a concurrent engine change between validation and mutation. Accounts without the required SELECT/metadata access fail before the DML.

Execute one prepared DML statement with multipleStatements:false and FOUND_ROWS enabled. UPDATE counts matched target rows, including unchanged values. Reject more than 1000 target rows, malformed row counts or server warnings and request rollback. INSERT VALUES has a preflight 1000-row limit. A confirmed COMMIT is required before returning committed:true. Commit-acknowledgement or rollback uncertainty is reported explicitly without retry. The cap does not count every cascade/trigger effect; auto-increment allocation, nontransactional trigger effects and external effects are not promised to roll back.

After two seconds of DML execution, request KILL QUERY for only the known ID of this operation's own data connection, then close both connections. A cancellation flag prevents the same timer from racing into a later COMMIT. This is not a guarantee of immediate server-side termination: MySQL cancellation is asynchronous and may be unavailable behind some proxies. Timeout responses say that commit was not sent, cancellation was attempted and the outcome must be checked before retrying. No privilege grant, system setting change or automatic replay is performed.

The existing disposable MySQL CI service runs real HTTP opt-in, exact bigint/blob write/readback, update/delete, duplicate-key rollback, unchanged UPDATE row counting, over-limit rollback, warning rollback on a non-strict fixture session, read-only grant rejection, timeout/readback, a concurrent own-DDL metadata-lock check and pinned SSH writes. Local driver-contract tests separately cover commit/rollback uncertainty and cancellation targeting. Running those contract tests alone does not count as real database validation.

References:
- https://github.com/taozhi8833998/node-sql-parser
- https://dev.mysql.com/doc/refman/8.0/en/metadata-locking.html
- https://dev.mysql.com/doc/c-api/8.0/en/mysql-affected-rows.html
- https://dev.mysql.com/doc/refman/8.0/en/kill.html
