import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { importDocument } from "../src/core.mjs";

const mcpPath = fileURLToPath(new URL("../src/mcp.mjs", import.meta.url));
const replacement = 'wire"\\;&=中文';
const encoded = "wire%22%5C%3B%26%3D%E4%B8%AD%E6%96%87";
function definition(origin, group, location) {
  const query = group === "query";
  const parameter = {
    in: query ? "query" : "header",
    name: "filter",
    style: query ? "form" : "simple",
    explode: true,
    schema: query
      ? { type: "array", items: { type: "string" } }
      : { type: "object", properties: { role: { type: "string" } } },
  };
  parameter.schema[location] = query ? ["{{unused}}"] : { role: "{{unused}}" };
  return importDocument({
    openapi: "3.1.0",
    info: { title: "Schema source isolation", version: "1" },
    servers: [{ url: origin }],
    paths: {
      "/echo": {
        get: {
          parameters: [parameter],
          responses: { 200: { description: "ok" } },
        },
      },
    },
  })[0];
}
const value = (group) =>
  group === "query" ? [replacement] : { role: replacement };
const expected = (group) => ({
  path: group === "query" ? "/echo?filter=" + encoded : "/echo",
  filter: group === "query" ? null : "role=" + encoded,
  authorization: "Bearer fixture-token",
});
function passed(run, group) {
  assert.equal(run.status, "passed", JSON.stringify(run));
  assert.equal(run.results.length, 1);
  assert.equal(run.results[0].response.status, 200);
  assert.deepEqual(JSON.parse(run.results[0].response.body), expected(group));
}
const decode = (result) => {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
};
async function fixture(t) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "parameter-schema-source-"),
  );
  const clients = [],
    seen = [];
  const peer = http.createServer((req, res) => {
    const entry = {
      path: req.url,
      filter: req.headers.filter ?? null,
      authorization: req.headers.authorization ?? null,
    };
    seen.push(entry);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(entry));
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
  const call = async (url, method = "GET", body, status = 200) => {
    const response = await fetch(app.url + url, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  };
  return {
    root,
    seen,
    call,
    origin: "http://127.0.0.1:" + peer.address().port,
    async restart() {
      for (const client of clients) await client.close();
      clients.length = 0;
      await closeApp();
      app = await createApp({ root, port: 0 });
    },
    async connect(kind, projectId) {
      const client = new Client(
        { name: "parameter-schema-source", version: "1" },
        { capabilities: {} },
      );
      clients.push(client);
      let transport;
      if (kind === "http") {
        const config = await call("/api/mcp/config", "POST", {
          enabled: true,
          projects: [projectId],
          write: true,
          execute: true,
          remember: false,
        });
        transport = new StreamableHTTPClientTransport(
          new URL(app.url + "/mcp"),
          {
            requestInit: {
              headers: { Authorization: "Bearer " + config.token },
            },
          },
        );
      } else {
        transport = new StdioClientTransport({
          command: process.execPath,
          args: [mcpPath, "--project", projectId, "--write", "--execute"],
          env: { ...process.env, LOCAL_API_DATA: root },
          stderr: "pipe",
        });
      }
      await client.connect(transport);
      return (name, args) =>
        client.callTool({
          name: "localapi_" + name,
          arguments: { projectId, ...args },
        });
    },
  };
}

test(
  "official SDK HTTP and stdio replace Query-array/Header-object schema examples without old variables",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      store = new Store(f.root),
      p = await store.create("Parameter sources");
    p.environments[0].variables.token = "fixture-token";
    p.requests = [];
    const cases = [];
    for (const group of ["query", "headers"])
      for (const location of ["example", "default"]) {
        const request = definition(f.origin, group, location);
        request.auth = { type: "bearer", token: "{{token}}" };
        p.requests.push(request);
        cases.push({ group, request });
      }
    await store.save(p);
    const original = (await store.get(p.id)).requests;
    for (const kind of ["http", "stdio"]) {
      const invoke = await f.connect(kind, p.id);
      for (const { group, request } of cases) {
        const before = f.seen.length;
        const failure = decode(
          await invoke("execute_api", { apiId: request.id }),
        );
        assert.equal(failure.status, "failed", JSON.stringify(failure));
        assert.match(failure.results[0].error, /未定义变量: unused/);
        assert.equal(f.seen.length, before);
        const run = decode(
          await invoke("execute_api", {
            apiId: request.id,
            input: { [group]: { filter: value(group) } },
          }),
        );
        passed(run, group);
        assert.equal(f.seen.length, before + 1);
        assert.deepEqual(
          run.results[0].request[group][0].schema,
          request[group][0].schema,
        );
        assert.deepEqual(
          run.results[0].request.openapiOperation,
          request.openapiOperation,
        );
        assert.deepEqual((await store.get(p.id)).requests, original);
      }
    }
    await f.restart();
    const reopened = await new Store(f.root).get(p.id);
    assert.deepEqual(reopened.requests, original);
    assert.equal(
      Object.hasOwn(reopened.environments[0].variables, "unused"),
      false,
    );
  },
);

test(
  "fixed dynamic parameter values survive frozen plans, backup and restart without rewriting source schemas",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    let p = await f.call(
      "/api/projects",
      "POST",
      { name: "Frozen parameter sources" },
      201,
    );
    p.environments[0].variables.token = "fixture-token";
    p.requests = [];
    for (const group of ["query", "headers"])
      for (const location of ["example", "default"]) {
        const request = definition(f.origin, group, location);
        request.auth = { type: "bearer", token: "{{token}}" };
        request[group][0].dynamic = { source: "fixed", value: value(group) };
        p.requests.push(request);
      }
    p = await f.call(`/api/projects/${p.id}`, "PUT", p);
    const saved = structuredClone(p.requests),
      plans = [];
    for (const request of saved) {
      plans.push(
        await f.call(`/api/projects/${p.id}/plans`, "POST", {
          name: "Frozen source",
          environmentId: p.environments[0].id,
          steps: [{ request }],
        }),
      );
    }
    p = await f.call(`/api/projects/${p.id}`);
    const frozen = structuredClone(p.plans);
    for (const request of p.requests) {
      const group = request.query.length ? "query" : "headers";
      request[group][0].dynamic.value =
        group === "query" ? ["live-edited"] : { role: "live-edited" };
    }
    p = await f.call(`/api/projects/${p.id}`, "PUT", p);
    const edited = structuredClone(p.requests);
    const backup = await f.call(`/api/projects/${p.id}/export`);
    const restored = await f.call(
      "/api/restore",
      "POST",
      { document: backup },
      201,
    );
    await f.restart();
    const reopened = await new Store(f.root).get(restored.id);
    assert.deepEqual(reopened.requests, edited);
    assert.deepEqual(reopened.plans, frozen);
    for (let index = 0; index < plans.length; index++) {
      const group = saved[index].query.length ? "query" : "headers";
      const before = f.seen.length;
      const run = await f.call(`/api/projects/${restored.id}/run`, "POST", {
        planId: plans[index].id,
      });
      passed(run, group);
      assert.equal(f.seen.length, before + 1);
      assert.deepEqual(
        run.results[0].request[group][0].schema,
        saved[index][group][0].schema,
      );
    }
    const after = await new Store(f.root).get(restored.id);
    assert.deepEqual(after.requests, edited);
    assert.deepEqual(after.plans, frozen);
    assert.equal(
      Object.hasOwn(after.environments[0].variables, "unused"),
      false,
    );
  },
);
