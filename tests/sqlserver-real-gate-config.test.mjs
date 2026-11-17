import test from "node:test";
import assert from "node:assert/strict";
import {
  gateEnabled,
  validateGateConfig,
  requireRestrictedPermissions,
} from "./helpers/sqlserver-real-gate.mjs";
const connection = {
  host: "localhost",
  port: 1433,
  user: "gate_reader",
  password: "synthetic-not-secret",
  ca: "synthetic-ca",
  ssl: true,
};
const fixture = () => ({
  disposable: true,
  readOnly: { ...connection, database: "localapi_gate_ro" },
  readWrite: { ...connection, database: "localapi_gate_rw" },
});
test("gate opts out by default, enabled missing config fails closed", () => {
  assert.equal(gateEnabled({}), false);
  assert.equal(gateEnabled({ LOCALAPI_SQLSERVER_REAL: "0" }), false);
  for (const env of [
    { LOCALAPI_SQLSERVER_REAL: "true" },
    { LOCALAPI_SQLSERVER_REAL: "1" },
  ])
    assert.throws(() => gateEnabled(env));
  assert.equal(
    gateEnabled({
      LOCALAPI_SQLSERVER_REAL: "1",
      LOCALAPI_SQLSERVER_REAL_CONFIG: "fixture.json",
    }),
    true,
  );
});
test("strict disposable configuration requires distinct named DBs, credentials and verified TLS", () => {
  assert.deepEqual(validateGateConfig(fixture()), fixture());
  for (const mutate of [
    (v) => (v.disposable = false),
    (v) => (v.readOnly.ssl = false),
    (v) => (v.readOnly.ca = ""),
    (v) => (v.readOnly.password = ""),
    (v) => (v.readWrite.database = "localapi_gate_ro"),
    (v) => (v.readOnly.trustServerCertificate = true),
    (v) => (v.extra = true),
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateGateConfig(value), /CONFIG_INVALID/);
  }
});
test("permission gate rejects elevated, write-enabled, missing and unknown rights", () => {
  const row = {
    sysadmin: 0,
    server_control: 0,
    database_control: 0,
    can_select: 1,
    can_insert: 0,
    can_update: 0,
    can_delete: 0,
    can_alter: 0,
  };
  requireRestrictedPermissions(row);
  for (const key of Object.keys(row))
    assert.throws(() =>
      requireRestrictedPermissions({
        ...row,
        [key]: key === "can_select" ? 0 : 1,
      }),
    );
  assert.throws(() => requireRestrictedPermissions({}));
  assert.throws(() => requireRestrictedPermissions({ ...row, extra: 0 }));
});

test("paired databases must use same host and normalized port", () => {
  for (const mutate of [
    (v) => (v.readWrite.host = "other.invalid"),
    (v) => (v.readWrite.port = 1434),
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateGateConfig(value));
  }
  const value = fixture();
  delete value.readOnly.port;
  assert.doesNotThrow(() => validateGateConfig(value));
});
test("shared real gate SELECT compiles with actual bounded compiler", async () => {
  const { compileSQLServerRead } = await import(
    "../src/sqlserver-read-contract.mjs"
  );
  const { GATE_SQL } = await import("./helpers/sqlserver-real-gate.mjs");
  const plan = await compileSQLServerRead(GATE_SQL, [1]);
  assert.match(
    plan.sql,
    /^SELECT TOP \(1001\) \[id\], \[payload\] FROM \[dbo\]\.\[workbench_sqlserver_gate\] WHERE/,
  );
  assert.deepEqual(plan.parameters, [{ name: "p0", type: "Int", value: 1 }]);
  assert.equal(plan.requiredDatabaseUpdateability, "READ_ONLY");
});
