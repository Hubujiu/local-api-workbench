import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import http2 from "node:http2";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store, executeRequest } from "../src/runtime.mjs";
import { importDocument, toCurl, runPlan, snapshotPlan } from "../src/core.mjs";

const text = 'quote"中文 +/&=%';
const encoded = "quote%22%E4%B8%AD%E6%96%87%20%2B%2F%26%3D%25";
const objectValue = (role = text) => ({ role, count: 0, active: false });
const queryPath = (role = encoded) =>
  "/search?role=" + role + "&count=0&active=false&ordinary=kept";
const marker = { version: 1, style: "form", explode: true };
const mcpPath = fileURLToPath(new URL("../src/mcp.mjs", import.meta.url));
function document(origin, example = objectValue()) {
  return {
    openapi: "3.1.0",
    info: { title: "Query object", version: "1" },
    servers: [{ url: origin }],
    paths: {
      "/search": {
        get: {
          operationId: "search",
          parameters: [
            {
              in: "query",
              name: "filter",
              style: "form",
              explode: true,
              allowReserved: false,
              schema: {
                type: "object",
                properties: {
                  role: { type: "string" },
                  count: { type: "integer" },
                  active: { type: "boolean" },
                },
                additionalProperties: false,
              },
              example,
            },
            {
              in: "query",
              name: "ordinary",
              schema: { type: "string" },
              example: "kept",
            },
          ],
          responses: { 200: { description: "Echo" } },
        },
      },
    },
  };
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "query-object-workflow-"));
  const seen = [],
    authorization = [],
    clients = new Set();
  const peer = http.createServer((request, response) => {
    seen.push(request.url);
    authorization.push(request.headers.authorization);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ path: request.url }));
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  let app = await createApp({ root, port: 0 });
  const closeApp = async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
    await closeApp();
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const call = async (url, method = "GET", data, status = 200) => {
    const response = await fetch(app.url + url, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const out = await response.json();
    assert.equal(response.status, status, JSON.stringify(out));
    return out;
  };
  return {
    root,
    seen,
    authorization,
    clients,
    call,
    origin: "http://127.0.0.1:" + peer.address().port,
    get app() {
      return app;
    },
    async restart() {
      await closeApp();
      app = await createApp({ root, port: 0 });
    },
  };
}
async function connect(f, kind, projectId) {
  const client = new Client(
    { name: "query-object-workflow", version: "1" },
    { capabilities: {} },
  );
  f.clients.add(client);
  let transport;
  if (kind === "http") {
    const config = await f.call("/api/mcp/config", "POST", {
      enabled: true,
      projects: [projectId],
      write: true,
      execute: true,
      remember: false,
    });
    transport = new StreamableHTTPClientTransport(new URL(f.app.url + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + config.token } },
    });
  } else
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [mcpPath, "--project", projectId, "--write", "--execute"],
      env: { ...process.env, LOCAL_API_DATA: f.root },
      stderr: "pipe",
    });
  await client.connect(transport);
  return (name, args = {}) =>
    client.callTool({
      name: "localapi_" + name,
      arguments: { projectId, ...args },
    });
}
function decode(result) {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}
function assertRun(run, expected = queryPath()) {
  assert.equal(run.status, "passed", JSON.stringify(run));
  assert.equal(run.results.length, 1);
  assert.equal(run.results[0].response.status, 200);
  assert.deepEqual(JSON.parse(run.results[0].response.body), {
    path: expected,
  });
}

test(
  "query object produces encoded property pairs through actual HTTP/1.1, HTTP/2 and curl",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const [request] = importDocument(document(f.origin));
    const expected = queryPath();
    assert.deepEqual(JSON.parse((await executeRequest(request)).body), {
      path: expected,
    });
    const h2 = http2.createServer();
    h2.on("stream", (stream, headers) => {
      stream.respond({ ":status": 200, "content-type": "application/json" });
      stream.end(JSON.stringify({ path: headers[":path"] }));
    });
    await new Promise((resolve) => h2.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => h2.close(resolve)));
    assert.deepEqual(
      JSON.parse(
        (
          await executeRequest({
            ...request,
            httpVersion: "2",
            url: `http://127.0.0.1:${h2.address().port}/search`,
          })
        ).body,
      ),
      { path: expected },
    );
    const command = toCurl(request);
    assert.equal(command.includes("'\\''"), false);
    const args = [...command.matchAll(/'([^']*)'|(\S+)/g)].map(
      (match) => match[1] ?? match[2],
    );
    assert.equal(args.shift(), "curl");
    const result = await new Promise((resolve, reject) => {
      const child = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "",
        stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(Error("curl timeout"));
      }, 5000);
      child.stdout.on("data", (data) => (stdout += data));
      child.stderr.on("data", (data) => (stderr += data));
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { path: expected });
  },
);

test(
  "query object OpenAPI roundtrip, frozen Store/reopen/backup and SDK temporary input preserve the contract",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    let p = await f.call(
      "/api/projects",
      "POST",
      { name: "Query object" },
      201,
    );
    const url = `/api/projects/${p.id}`;
    p = await f.call(url + "/import", "POST", { document: document(f.origin) });
    const saved = structuredClone(p.requests[0]);
    assert.deepEqual(saved.query[0].queryObjectSerialization, marker);
    const out = await f.call(url + "/export?format=openapi");
    assert.equal(out.paths["/search"].get.parameters[0].allowReserved, false);
    assert.equal(out.paths["/search"].get.parameters[0].explode, true);
    assert.deepEqual(
      out.paths["/search"].get.parameters[0].example,
      objectValue(),
    );
    let fresh = await f.call(
      "/api/projects",
      "POST",
      { name: "Query object roundtrip" },
      201,
    );
    fresh = await f.call(`/api/projects/${fresh.id}/import`, "POST", {
      document: out,
    });
    assert.deepEqual(fresh.requests[0].query, saved.query);
    const freshPlan = await f.call(`/api/projects/${fresh.id}/plans`, "POST", {
      name: "Roundtrip",
      environmentId: fresh.environments[0].id,
      steps: [{ request: fresh.requests[0] }],
    });
    assertRun(
      await f.call(`/api/projects/${fresh.id}/run`, "POST", {
        planId: freshPlan.id,
      }),
    );
    const frozen = await f.call(url + "/plans", "POST", {
      name: "Frozen",
      environmentId: p.environments[0].id,
      steps: [{ request: saved }],
    });
    p = await f.call(url);
    p.requests[0].query[0].value = JSON.stringify(objectValue("live/changed"));
    p = await f.call(url, "PUT", p);
    await f.restart();
    assert.equal(
      (await new Store(f.root).get(p.id)).requests[0].query[0].value,
      JSON.stringify(objectValue("live/changed")),
    );
    assertRun(await f.call(url + "/run", "POST", { planId: frozen.id }));
    const backup = await f.call(url + "/export");
    const restored = await f.call(
      "/api/restore",
      "POST",
      { document: backup },
      201,
    );
    assert.deepEqual(restored.requests, backup.requests);
    assert.deepEqual(restored.plans, backup.plans);
    await f.restart();
    assertRun(
      await f.call(`/api/projects/${restored.id}/run`, "POST", {
        planId: frozen.id,
      }),
    );
    const untouched = await new Store(f.root).get(fresh.id);
    for (const kind of ["http", "stdio"]) {
      const invoke = await connect(f, kind, p.id),
        before = (await f.call(url)).requests;
      assertRun(
        decode(
          await invoke("execute_api", {
            apiId: saved.id,
            input: {
              query: { filter: objectValue("temporary/&role=admin+%2f") },
            },
          }),
        ),
        queryPath("temporary%2F%26role%3Dadmin%2B%252f"),
      );
      assert.deepEqual((await f.call(url)).requests, before);
      const count = f.seen.length;
      for (const value of [
        "not-an-object",
        {},
        { role: "value", extra: "undeclared" },
        objectValue(""),
        { ...objectValue(), count: Number.MAX_SAFE_INTEGER + 1 },
        { ...objectValue(), role: { nested: true } },
      ]) {
        const rejected = await invoke("execute_api", {
          apiId: saved.id,
          input: { query: { filter: value } },
        });
        assert.equal(rejected.isError, true, JSON.stringify(rejected));
        assert.equal(f.seen.length, count);
      }
      const denied = await invoke("run_plan", {
        projectId: fresh.id,
        planId: freshPlan.id,
      });
      assert.equal(denied.isError, true);
      assert.equal(f.seen.length, count);
    }
    assert.deepEqual(await new Store(f.root).get(fresh.id), untouched);
  },
);

test(
  "query object dynamic/temporary inputs do not evaluate replaced source examples and reject unsafe values before network",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const [request] = importDocument(
      document(f.origin, objectValue("{{unused}}")),
    );
    request.query[0].dynamic = {
      source: "fixed",
      value: objectValue("dynamic/&x=1+%2f"),
    };
    const original = structuredClone(request);
    assertRun(
      await runPlan(snapshotPlan({ steps: [{ request }] }), {}, executeRequest),
      queryPath("dynamic%2F%26x%3D1%2B%252f"),
    );
    assert.deepEqual(request, original);
    const count = f.seen.length;
    for (const value of [
      "not-an-object",
      {},
      { ...objectValue(), role: [] },
      { ...objectValue(), count: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      request.query[0].dynamic.value = value;
      const failed = await runPlan(
        snapshotPlan({ steps: [{ request }] }),
        {},
        executeRequest,
      );
      assert.equal(failed.status, "failed", JSON.stringify(failed));
      assert.equal(f.seen.length, count);
    }
    let p = await f.call("/api/projects", "POST", { name: "Replacement" }, 201);
    const url = `/api/projects/${p.id}`;
    for (const location of ["parameter", "example", "default"]) {
      const source = document(f.origin, objectValue("{{unused}}"));
      source.paths["/search"].get.operationId = "search-" + location;
      if (location !== "parameter") {
        const param = source.paths["/search"].get.parameters[0];
        delete param.example;
        param.schema[location] = objectValue("{{unused}}");
      }
      p = await f.call(url + "/import", "POST", { document: source });
    }
    for (const kind of ["http", "stdio"]) {
      const invoke = await connect(f, kind, p.id);
      for (const r of p.requests)
        assertRun(
          decode(
            await invoke("execute_api", {
              apiId: r.id,
              input: { query: { filter: objectValue("replacement/path") } },
            }),
          ),
          queryPath("replacement%2Fpath"),
        );
    }
  },
);

test(
  "query object basic and bearer authentication preserve the exact request target",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const [request] = importDocument(document(f.origin));
    const expected = queryPath();
    for (const [auth, header] of [
      [
        {
          type: "basic",
          username: "fixture-user",
          password: "fictional-password",
        },
        "Basic " +
          Buffer.from("fixture-user:fictional-password").toString("base64"),
      ],
      [{ type: "bearer", token: "fictional-token" }, "Bearer fictional-token"],
    ]) {
      const before = structuredClone(request);
      assert.deepEqual(
        JSON.parse((await executeRequest({ ...request, auth })).body),
        { path: expected },
      );
      assert.equal(f.authorization.at(-1), header);
      assert.equal(f.seen.at(-1), expected);
      assert.deepEqual(request, before);
    }
    assert.equal(f.seen.length, 2);
  },
);

test(
  "query object collisions and unsupported combinations fail before network or durable import",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const [request] = importDocument(document(f.origin));
    const conflicting = structuredClone(request);
    conflicting.query.push({ key: "role", value: "collision", enabled: true });
    for (const invalid of [
      conflicting,
      { ...request, url: request.url + "?other=1" },
      {
        ...request,
        auth: { type: "apiKey", in: "query", key: "role", value: "collision" },
      },
      { ...request, queryAddEqual: false },
    ]) {
      await assert.rejects(() => executeRequest(invalid));
      assert.equal(f.seen.length, 0);
    }
    let p = await f.call(
      "/api/projects",
      "POST",
      { name: "Atomic collision" },
      201,
    );
    const url = `/api/projects/${p.id}`;
    p = await f.call(url + "/import", "POST", { document: document(f.origin) });
    const before = await new Store(f.root).get(p.id);
    const source = document(f.origin);
    source.paths["/search"].get.parameters[1].name = "role";
    await f.call(url + "/import", "POST", { document: source }, 400);
    assert.deepEqual(await new Store(f.root).get(p.id), before);
    assert.equal(f.seen.length, 0);
  },
);

test(
  "query object runtime key, BEFORE-script and URL changes reject collisions before HTTP",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const [base] = importDocument(document(f.origin));
    const keyTemplate = structuredClone(base);
    keyTemplate.query.push({
      key: "{{key}}",
      value: "from-variable",
      enabled: true,
    });
    const scripted = {
      ...structuredClone(base),
      beforeScript: "pm.setRequestQuery('role', 'from-before-script');",
    };
    const dynamicURL = {
      ...structuredClone(base),
      url: f.origin + "/{{route}}",
    };
    for (const [request, variables, error] of [
      [keyTemplate, { key: "role" }, /冲突/],
      [scripted, {}, /冲突/],
      [dynamicURL, { route: "search?role=from-url" }, /原始Query/],
    ]) {
      const before = structuredClone(request);
      const result = await runPlan(
        snapshotPlan({ steps: [{ request }] }),
        variables,
        executeRequest,
      );
      assert.equal(result.status, "failed", JSON.stringify(result));
      assert.equal(result.results.length, 1);
      assert.match(result.results[0].error, error);
      assert.equal(f.seen.length, 0);
      assert.deepEqual(request, before);
    }
  },
);

test(
  "global and folder Query defaults cannot collide with object properties after environment resolution",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    for (const scope of ["global", "folder"]) {
      let p = await f.call(
        "/api/projects",
        "POST",
        { name: "Inherited " + scope },
        201,
      );
      const url = `/api/projects/${p.id}`;
      p = await f.call(url + "/import", "POST", {
        document: document(f.origin),
      });
      const rows = {
        query: [
          { key: "{{inheritedKey}}", value: "from-" + scope, enabled: true },
        ],
      };
      p.environments[0].variables.inheritedKey = "role";
      p.settings ??= {};
      if (scope === "global") p.settings.globalParameters = rows;
      else {
        p.folders = [...new Set([...(p.folders || []), "Group"])];
        p.requests[0].folder = "Group";
        p.settings.folderParameters = { Group: rows };
      }
      p = await f.call(url, "PUT", p);
      const frozen = await f.call(url + "/plans", "POST", {
        name: "Inherited collision",
        environmentId: p.environments[0].id,
        steps: [{ request: p.requests[0] }],
      });
      assert(
        frozen.steps[0].request.query.some(
          (row) => row.key === "{{inheritedKey}}",
        ),
      );
      const result = await f.call(url + "/run", "POST", { planId: frozen.id });
      assert.equal(result.status, "failed", JSON.stringify(result));
      assert.equal(result.results.length, 1);
      assert.match(result.results[0].error, /冲突/);
      assert.equal(f.seen.length, 0);
      assert.deepEqual((await f.call(url)).requests, p.requests);
    }
  },
);
