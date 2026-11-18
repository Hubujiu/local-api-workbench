# Frozen database task provenance in directory exports

Frozen native flow snapshots already import API database tasks into inert
`importedNativeTaskSource`. They do not run those tasks. Directory export now
supports that source through the existing explicit `databaseMode=rebind` profile,
limited to PostgreSQL and MySQL without SSH. It does not infer new native graph
semantics or enable live database tasks in frozen steps.

The existing database adapter supplies the native connection reference, variable
scope spelling and MySQL result-set shape. The exported database catalog contains
empty connection credentials, not a working connection, session or grant.
Catalog identities change on reimport. The final complete directory readback
therefore compares source after an explicit old-to-new catalog identity mapping;
query, variable scopes/paths, task IDs, names, order, enabled state and result
shape must still agree exactly. Missing bindings fail closed. PostgreSQL must
not carry a MySQL result shape. Existing credential, SSH, unsupported provider,
inherited source, mixed source and executable snapshot-pipeline guards remain.

This is credential-free definition interchange, not credential preservation or
proof of original-app interoperability. No connection setup or authorization is
performed. Restored source remains inert even when its historical enabled flag
is 1. Only the flow's explicit step scripts execute.

`tests/native-flow-database-source-roundtrip.test.mjs` uses independently authored
synthetic PostgreSQL/MySQL source, a real local HTTP endpoint and real Workbench
owner routes. It covers two directory generations, unauthenticated export
rejection, authenticated export, persisted restore/restart, exact remapped source,
empty credentials, absent live APIs and successful HTTP runs without database
bindings or database-produced variables. Negative checks cover ambiguous or
missing bindings, credentials, SSH, origin, unsupported shape/write metadata,
and corrupted readback. This does not run a database driver or original app.
