import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import tls from "node:tls";
import { X509Certificate } from "node:crypto";
import { loadOracleReadWorkerDriver } from "../src/oracle-read-worker-runtime.mjs";
import { runOracleReadWithDriver } from "../src/oracle-read-wip.mjs";

const pem = new X509Certificate(
  readFileSync(new URL("./fixtures/localhost.crt", import.meta.url)),
).toString();
const input = (patch = {}) => ({
  host: "localhost",
  port: 1521,
  service: "FREEPDB1",
  user: "reader",
  password: "fixture-only",
  ssl: true,
  sql: "SELECT 1 FROM DUAL",
  ...patch,
});

test("child trust setup replaces defaults before driver load; parent is unchanged", async () => {
  const before = tls.getCACertificates("default"),
    calls = [],
    driver = {};
  const loaded = await loadOracleReadWorkerDriver(
    input({ caCertificatePem: pem.replaceAll("\n", "\r\n") }),
    async () => {
      calls.push("load");
      return driver;
    },
    {
      tlsModule: {
        setDefaultCACertificates(certs) {
          assert.deepEqual(certs, [pem]);
          calls.push("trust");
        },
      },
    },
  );
  assert.deepEqual(calls, ["trust", "load"]);
  assert.deepEqual(loaded, { driver, configuredCaCertificatePem: pem });
  assert.deepEqual(tls.getCACertificates("default"), before);
});

test("missing custom-CA API or failed setup imports nothing and fails closed", async () => {
  for (const tlsModule of [
    {},
    { setDefaultCACertificates: false },
    {
      setDefaultCACertificates() {
        throw Error("private certificate details");
      },
    },
  ]) {
    let imports = 0;
    await assert.rejects(
      loadOracleReadWorkerDriver(
        input({ caCertificatePem: pem }),
        async () => {
          imports++;
        },
        { tlsModule },
      ),
      {
        code: "ORACLE_WIP_TLS_UNAVAILABLE",
        message:
          "Oracle WIP custom CA trust unavailable; connection not attempted",
      },
    );
    assert.equal(imports, 0);
  }
});

test("absent CA leaves trust untouched and does not require the new API", async () => {
  for (const tlsModule of [
    {},
    {
      setDefaultCACertificates() {
        assert.fail("must not change standard trust");
      },
    },
  ]) {
    let imports = 0;
    const loaded = await loadOracleReadWorkerDriver(
      input(),
      async () => {
        imports++;
        return {};
      },
      { tlsModule },
    );
    assert.equal(imports, 1);
    assert.equal(loaded.configuredCaCertificatePem, undefined);
  }
});

test("child independently rejects malformed input before trust or driver load", async () => {
  for (const patch of [
    { caCertificatePem: pem + pem },
    { caCertificatePem: "/tmp/ca.pem" },
    { caCertificatePem: undefined },
    { caCertificatePem: pem, walletLocation: "/tmp/wallet" },
  ]) {
    let calls = 0;
    await assert.rejects(
      loadOracleReadWorkerDriver(
        input(patch),
        async () => {
          calls++;
        },
        {
          tlsModule: {
            setDefaultCACertificates() {
              calls++;
            },
          },
        },
      ),
    );
    assert.equal(calls, 0);
  }
});

test("direct injected executor cannot silently ignore configured CA", async () => {
  let connections = 0;
  await assert.rejects(
    runOracleReadWithDriver(input({ caCertificatePem: pem }), {
      driver: {
        thin: true,
        getConnection() {
          connections++;
        },
      },
    }),
    { code: "ORACLE_WIP_TLS_UNAVAILABLE" },
  );
  assert.equal(connections, 0);
});
