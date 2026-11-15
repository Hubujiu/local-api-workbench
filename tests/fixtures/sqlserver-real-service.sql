-- Operator-run only, in each already-approved DISPOSABLE fixture database.
-- No server install, login creation, ALTER DATABASE, DROP or cleanup here.
IF DB_NAME() NOT IN ('localapi_gate_ro', 'localapi_gate_rw')
  THROW 51000, 'Select the named disposable fixture database', 1;
IF OBJECT_ID('dbo.workbench_sqlserver_gate') IS NOT NULL
  THROW 51001, 'Fixture object already exists; inspect instead of overwriting', 1;
CREATE TABLE dbo.workbench_sqlserver_gate (
  id int NOT NULL PRIMARY KEY,
  payload nvarchar(64) NOT NULL
);
INSERT INTO dbo.workbench_sqlserver_gate(id, payload)
VALUES (1, N'workbench-sqlserver-real-gate');
