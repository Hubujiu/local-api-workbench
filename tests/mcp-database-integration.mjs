import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";
import { snapshotPlan, importIntoProject } from "../src/core.mjs";
import { nativeDatabaseFixture } from "./fixtures/apipost-database.mjs";
export async function verifyMCPDatabaseFlow(
  config,
  { nativeImport = false } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-database-"));
  let app = await createApp({ root, port: 0 }),
    calls = 0;
  const clients = [];
  const echo = http.createServer((req, res) => {
    calls++;
    res.end(JSON.stringify({ value: req.headers["x-db-value"] }));
  });
  await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
  try {
    let p = await app.store.create("MCP grant fixture");
    const other = await app.store.create("other");
    let bindingId;
    if (nativeImport) {
      importIntoProject(
        p,
        nativeDatabaseFixture(
          `http://127.0.0.1:${echo.address().port}/`,
          config.type === "mysql" ? "mysql" : "pg",
        ),
      );
      await app.store.save(p);
      bindingId = p.settings.apipostDatabases[0].id;
    }
    const headers = () => ({
      "content-type": "application/json",
      "x-local-token": app.token,
    });
    const endpoint = (id = p.id) =>
      app.url + "/api/projects/" + id + "/mcp-database-connections";
    const grantInput = {
      ...config,
      name: "explicit MCP only",
      ...(bindingId ? { bindingId } : {}),
    };
    const configure = async (extra = {}) => {
      const response = await fetch(app.url + "/api/mcp/config", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          enabled: true,
          projects: [p.id],
          write: true,
          execute: true,
          remember: false,
          ...extra,
        }),
      });
      assert.equal(response.ok, true);
      return response.json();
    };
    const connect = async (token) => {
      const c = new Client(
        { name: "mcp-db-fixture", version: "1.0.0" },
        { capabilities: {} },
      );
      clients.push(c);
      await c.connect(
        new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
          requestInit: { headers: { Authorization: "Bearer " + token } },
        }),
      );
      return c;
    };
    const grant = async () => {
      const response = await fetch(endpoint(), {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(grantInput),
      });
      assert.equal(response.ok, true, await response.clone().text());
      return response.json();
    };
    const putPlan = async (connection) => {
      p = await app.store.get(p.id);
      const request = nativeImport
        ? p.requests[0]
        : {
            url: `http://127.0.0.1:${echo.address().port}/`,
            inheritSharedScripts: false,
            nativeTasks: {
              version: 1,
              before: [
                {
                  type: "database",
                  enabled: 1,
                  data: {
                    connectionId: connection.id,
                    query: "SELECT 'from-database' AS value",
                    isConsoleOutput: -1,
                    variables: [
                      {
                        name: "value",
                        type: "environment",
                        pattern: "$[0].value",
                      },
                    ],
                  },
                },
                {
                  type: "customScript",
                  enabled: 1,
                  data: 'apt.setRequestHeader("x-db-value","prefix-"+pm.environment.get("value"));',
                },
              ],
              after: [
                {
                  type: "customScript",
                  enabled: 1,
                  data: 'pm.test("wire",()=>pm.expect(pm.response.json().value).to.equal("prefix-from-database"));',
                },
              ],
            },
          };
      p.plans = [snapshotPlan({ id: "mcp-db", steps: [{ request }] })];
      await app.store.save(p);
      return request;
    };
    const run = async (c) => {
      const result = await c.callTool({
        name: "localapi_run_plan",
        arguments: { projectId: p.id, planId: "mcp-db" },
      });
      assert.notEqual(result.isError, true, result.content?.[0]?.text);
      return JSON.parse(result.content[0].text);
    };
    assert.equal(
      (
        await fetch(endpoint(), {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(grantInput),
        })
      ).ok,
      false,
    );
    let policy = await configure({ execute: false });
    assert.equal(
      (
        await fetch(endpoint(), {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(grantInput),
        })
      ).ok,
      false,
    );
    policy = await configure();
    // An authorization change while a local grant body is still streaming must
    // not silently attach that old request to the replacement MCP token.
    const serialized = JSON.stringify(grantInput);
    let started;
    const admitted = new Promise((resolve) => {
      started = resolve;
    });
    const listener = (req) => {
      if (req.url.endsWith("/mcp-database-connections")) {
        app.server.off("request", listener);
        started();
      }
    };
    app.server.on("request", listener);
    let upload;
    const delayed = new Promise((resolve, reject) => {
      upload = http.request(
        endpoint(),
        {
          method: "POST",
          headers: {
            ...headers(),
            "content-length": Buffer.byteLength(serialized),
          },
        },
        (response) => {
          let data = "";
          response.on("data", (chunk) => (data += chunk));
          response.on("end", () =>
            resolve({ status: response.statusCode, data }),
          );
        },
      );
      upload.on("error", reject);
      upload.write(serialized.slice(0, Math.floor(serialized.length / 2)));
    });
    await admitted;
    policy = await configure({ rotate: true });
    upload.end(serialized.slice(Math.floor(serialized.length / 2)));
    const stale = await delayed;
    assert.equal(stale.status, 400);
    assert.match(stale.data, /撤销/);
    assert.deepEqual(
      await fetch(endpoint(), { headers: headers() }).then((r) => r.json()),
      [],
    );
    let c = await connect(policy.token);
    for (const h of [
      { "content-type": "application/json" },
      { ...headers(), Origin: "https://untrusted.example" },
    ])
      assert.equal(
        (
          await fetch(endpoint(), {
            method: "POST",
            headers: h,
            body: JSON.stringify(grantInput),
          })
        ).status,
        403,
      );
    for (const extra of [{ allowWrite: true }, { remember: true }])
      assert.equal(
        (
          await fetch(endpoint(), {
            method: "POST",
            headers: headers(),
            body: JSON.stringify({ ...grantInput, ...extra }),
          })
        ).ok,
        false,
      );
    assert.equal(
      (
        await fetch(endpoint(other.id), {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(grantInput),
        })
      ).ok,
      false,
    );
    let connection = await grant(),
      request = await putPlan(connection);
    const listed = await fetch(endpoint(), { headers: headers() }).then((r) =>
      r.json(),
    );
    assert.equal(listed.length, 1);
    for (const key of ["host", "filename", "password", "database", "user"])
      assert.equal(Object.hasOwn(listed[0], key), false);
    const passed = await run(c);
    assert.equal(passed.status, "passed", JSON.stringify(passed));
    assert.equal(passed.results[0].databaseQueries[0].status, "completed");
    assert.equal(calls, 1);
    const manual = await fetch(app.url + "/api/projects/" + p.id + "/execute", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ request }),
    }).then((r) => r.json());
    assert.equal(manual.outcome, "failed");
    assert.match(manual.error, /未授权|失效/);
    assert.equal(calls, 1);
    assert.equal(
      (
        await fetch(endpoint(), {
          method: "DELETE",
          headers: headers(),
          body: JSON.stringify({ id: connection.id }),
        })
      ).ok,
      true,
    );
    assert.equal((await run(c)).status, "failed");
    assert.equal(calls, 1);
    connection = await grant();
    await putPlan(connection);
    assert.equal((await run(c)).status, "passed");
    assert.equal(calls, 2);
    policy = await configure({ rotate: true });
    await assert.rejects(run(c));
    c = await connect(policy.token);
    assert.deepEqual(
      await fetch(endpoint(), { headers: headers() }).then((r) => r.json()),
      [],
    );
    assert.equal((await run(c)).status, "failed");
    assert.equal(calls, 2);
    connection = await grant();
    await putPlan(connection);
    await configure({ projects: [other.id] });
    assert.equal((await fetch(endpoint(), { headers: headers() })).ok, false);
    policy = await configure();
    c = await connect(policy.token);
    assert.equal((await run(c)).status, "failed");
    assert.equal(calls, 2);
    connection = await grant();
    await putPlan(connection);
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    app = await createApp({ root, port: 0 });
    policy = await configure();
    c = await connect(policy.token);
    assert.equal((await run(c)).status, "failed");
    assert.equal(calls, 2);
    if (nativeImport) {
      connection = await grant();
      await putPlan(connection);
      const apiResult = await c.callTool({
        name: "localapi_execute_api",
        arguments: { projectId: p.id, apiId: p.requests[0].id },
      });
      assert.notEqual(apiResult.isError, true, apiResult.content?.[0]?.text);
      const apiRun = JSON.parse(apiResult.content[0].text);
      assert.equal(apiRun.status, "passed", JSON.stringify(apiRun));
      assert.equal(calls, 3);
    }
    const disk = await app.store.get(p.id);
    if (config.filename)
      assert.equal(JSON.stringify(disk).includes(config.filename), false);
    if (config.password)
      assert.equal(JSON.stringify(disk).includes(config.password), false);
    assert.ok(disk.runs.some((record) => record.status === "passed"));
    assert.ok(disk.runs.some((record) => record.status === "failed"));
  } finally {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await new Promise((resolve) => echo.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}
