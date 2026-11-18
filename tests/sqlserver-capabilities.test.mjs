import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import {
  sqlServerPortInput,
  readSQLServerPreviewConnection,
} from "../public/sqlserver-preview-ui.js";

test("SQL Server GUI uses strict raw ports and requires a host-confirmed selector", () => {
  assert.equal(sqlServerPortInput(""), undefined);
  assert.equal(sqlServerPortInput("1433"), 1433);
  assert.equal(sqlServerPortInput("65535"), 65535);
  for (const raw of [
    "0",
    " 1433",
    "1433 ",
    "01433",
    "1e3",
    "0x599",
    "1.5",
    "-1",
    "65536",
    null,
    1433,
  ])
    assert.throws(() => sqlServerPortInput(raw));
  let reads = 0;
  assert.throws(
    () =>
      readSQLServerPreviewConnection({}, () => {
        reads++;
      }),
    /尚未确认/,
  );
  assert.equal(reads, 0);
});
test("capabilities are owner-protected read-only live host facts and never an activation API", async (t) => {
  const old = process.env.LOCALAPI_SQLSERVER_PREVIEW;
  delete process.env.LOCALAPI_SQLSERVER_PREVIEW;
  const root = await mkdtemp(join(tmpdir(), "sqlserver-capabilities-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    if (old === undefined) delete process.env.LOCALAPI_SQLSERVER_PREVIEW;
    else process.env.LOCALAPI_SQLSERVER_PREVIEW = old;
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const get = (
    path = "/api/database-capabilities",
    method = "GET",
    token = app.token,
  ) => fetch(app.url + path, { method, headers: { "x-local-token": token } });
  assert.equal((await get(undefined, undefined, "wrong")).status, 403);
  let response = await get();
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { sqlserverReadOnlyPreview: false });
  for (const method of ["POST", "PUT", "PATCH", "DELETE"])
    assert.equal((await get(undefined, method)).status, 405);
  assert.equal(
    (await get("/api/database-capabilities?sqlserverReadOnlyPreview=true"))
      .status,
    400,
  );
  assert.deepEqual(await (await get()).json(), {
    sqlserverReadOnlyPreview: false,
  });
  process.env.LOCALAPI_SQLSERVER_PREVIEW = "true";
  assert.deepEqual(await (await get()).json(), {
    sqlserverReadOnlyPreview: false,
  });
  process.env.LOCALAPI_SQLSERVER_PREVIEW = "read-only";
  assert.deepEqual(await (await get()).json(), {
    sqlserverReadOnlyPreview: true,
  });
  delete process.env.LOCALAPI_SQLSERVER_PREVIEW;
  assert.deepEqual(await (await get()).json(), {
    sqlserverReadOnlyPreview: false,
  });
});
test("failed/malformed/stale capability responses cannot authorize a selector", async () => {
  const { loadSQLServerPreviewCapability } = await import(
    "../public/sqlserver-preview-ui.js"
  );
  const selector = {
    isConnected: true,
    querySelector: () => null,
    append() {
      throw Error("must not append");
    },
  };
  for (const value of [
    {},
    { sqlserverReadOnlyPreview: "true" },
    { sqlserverReadOnlyPreview: false },
    null,
  ]) {
    await loadSQLServerPreviewCapability(selector, async () => value);
    assert.throws(() => readSQLServerPreviewConnection(selector, () => {}));
  }
  await loadSQLServerPreviewCapability(selector, async () => {
    throw Error("unavailable");
  });
  let resolve;
  const stale = loadSQLServerPreviewCapability(
    selector,
    () => new Promise((r) => (resolve = r)),
  );
  await loadSQLServerPreviewCapability(selector, async () => ({
    sqlserverReadOnlyPreview: false,
  }));
  resolve({ sqlserverReadOnlyPreview: true });
  await stale;
  assert.throws(() => readSQLServerPreviewConnection(selector, () => {}));
  selector.isConnected = false;
  await loadSQLServerPreviewCapability(selector, async () => ({
    sqlserverReadOnlyPreview: true,
  }));
  assert.throws(() => readSQLServerPreviewConnection(selector, () => {}));
});
test("confirmed GUI selection builds only provider fields without coercing defaults", async () => {
  const { loadSQLServerPreviewCapability } = await import(
    "../public/sqlserver-preview-ui.js"
  );
  const before = globalThis.document;
  globalThis.document = { createElement: () => ({}) };
  try {
    const options = [];
    const selector = {
      isConnected: true,
      querySelector: () => null,
      append: (o) => options.push(o),
    };
    await loadSQLServerPreviewCapability(selector, async () => ({
      sqlserverReadOnlyPreview: true,
    }));
    assert.equal(options[0].value, "sqlserver");
    const fields = {
      "#db-tls": { checked: true },
      "#db-port": { value: "" },
      "#db-ca": { value: "" },
      "#db-host": { value: "fixture.invalid" },
      "#db-user": { value: "inert" },
      "#db-password": { value: "inert-secret" },
      "#db-name": { value: "fixture" },
    };
    assert.deepEqual(
      readSQLServerPreviewConnection(selector, (k) => fields[k]),
      {
        type: "sqlserver",
        host: "fixture.invalid",
        user: "inert",
        password: "inert-secret",
        database: "fixture",
        ssl: true,
      },
    );
    fields["#db-port"].value = "1444";
    fields["#db-ca"].value = "inert-ca";
    const value = readSQLServerPreviewConnection(selector, (k) => fields[k]);
    assert.equal(value.port, 1444);
    assert.equal(value.ca, "inert-ca");
    fields["#db-tls"].checked = false;
    assert.throws(
      () => readSQLServerPreviewConnection(selector, (k) => fields[k]),
      /TLS/,
    );
  } finally {
    if (before === undefined) delete globalThis.document;
    else globalThis.document = before;
  }
});
