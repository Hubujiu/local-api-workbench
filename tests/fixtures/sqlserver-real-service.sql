-- Operator-run only, in each already-approved DISPOSABLE fixture database.
-- No server install, login creation, ALTER DATABASE, DROP or cleanup here.
IF DB_NAME() NOT IN ('localapi_gate_ro', 'localapi_gate_rw')
  THROW 51000, 'Select the named disposable fixture database', 1;
IF OBJECT_ID('dbo.workbench_sqlserver_gate') IS NOT NULL
  THROW 51001, 'Fixture object already exists; inspect instead of overwriting', 1;
CREATE TABLE dbo.workbench_sqlserver_gate (
  id int NOT NULL PRIMARY KEY,
  payload nvarchar(64) NOT NULL,
  exact_amount decimal(38,18) NULL,
  exact_stamp datetime2(7) NULL,
  exact_offset datetimeoffset(7) NULL,
  exact_clock time(7) NULL,
  exact_day date NULL
);
INSERT INTO dbo.workbench_sqlserver_gate(id, payload, exact_amount, exact_stamp, exact_offset, exact_clock, exact_day)
VALUES (1, N'workbench-sqlserver-real-gate',
  CONVERT(decimal(38,18), N'9007199254740993.123456789012345678'),
  CONVERT(datetime2(7), '2026-11-18T02:03:04.1234567', 126),
  DATETIMEOFFSETFROMPARTS(2026,11,18,2,3,4,1234567,5,30,7),
  CONVERT(time(7), '02:03:04.1234567'),
  CONVERT(date, '0001-01-01', 23)),
  (2, N'null-exact-values', NULL, NULL, NULL, NULL, NULL),
  (3, N'negative-time-zone', NULL, NULL, DATETIMEOFFSETFROMPARTS(2024,2,29,23,59,58,1234567,-7,-30,7), NULL, NULL),
  (4, N'utc-time-zone', NULL, NULL, DATETIMEOFFSETFROMPARTS(2024,2,29,23,59,58,1234567,0,0,7), NULL, NULL);
