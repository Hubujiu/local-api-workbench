-- Operator-run only in an approved disposable schema WORKBENCH_GATE.
-- No server installation, license acceptance, user creation or grants.
-- A separate least-privilege reader needs explicit SELECT on this table.
CREATE TABLE WORKBENCH_GATE.WORKBENCH_ORACLE_GATE (
  ID NUMBER(9,0) PRIMARY KEY,
  EXACT_AMOUNT NUMBER(38,18) NOT NULL
);
INSERT INTO WORKBENCH_GATE.WORKBENCH_ORACLE_GATE (ID, EXACT_AMOUNT)
VALUES (1, 9007199254740993.123456789012345678);
COMMIT;
