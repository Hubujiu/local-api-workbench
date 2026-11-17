import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import http2 from "node:http2";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store, executeRequest } from "../src/runtime.mjs";
import { ProjectCookieJar } from "../src/cookie-jar.mjs";
import { importDocument, toCurl, runPlan, snapshotPlan } from "../src/core.mjs";

const text = 'quo"te\\中文;,&=+/%';
const encoded = "quo%22te%5C%E4%B8%AD%E6%96%87%3B%2C%26%3D%2B%2F%25";
const cookie = (role = encoded) =>
  `role=${role}; active=false; count=0; ordinary=kept`;
const mcpPath = fileURLToPath(new URL("../src/mcp.mjs", import.meta.url));
const marker = {
  version: 1,
  style: "form",
  explode: true,
  dialect: "cookie-pairs",
};
function document(origin) {
  return {
    openapi: "3.1.0",
    info: { title: "Explicit Cookie pairs", version: "1" },
    servers: [{ url: origin }],
    paths: {
      "/pairs": {
        get: {
          operationId: "pairs",
          parameters: [
            {
              in: "cookie",
              name: "filter",
              style: "form",
              explode: true,
              "x-local-api-cookie-dialect": "cookie-pairs-v1",
              schema: {
                type: "object",
                properties: {
                  role: { type: "string" },
                  active: { type: "boolean" },
                  count: { type: "integer" },
                },
              },
              example: { role: "{{part}}", active: false, count: 0 },
            },
            {
              in: "cookie",
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
  const root = await mkdtemp(path.join(os.tmpdir(), "cookie-object-workflow-"));
  const seen = [],
    clients = new Set();
  const peer = http.createServer((request, response) => {
    const entry = { cookie: request.headers.cookie ?? null, path: request.url };
    seen.push(entry);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(entry));
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
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
async function connect(f, kind, projectId) {
  const client = new Client(
    { name: "cookie-object-workflow", version: "1" },
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
function assertRun(run, value = cookie()) {
  assert.equal(run.status, "passed", JSON.stringify(run));
  assert.equal(run.results.length, 1);
  assert.equal(run.results[0].response.status, 200);
  assert.deepEqual(JSON.parse(run.results[0].response.body), {
    cookie: value,
    path: "/pairs",
  });
}
async function diskFiles(directory, prefix = "") {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(prefix, entry.name),
      file = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await diskFiles(file, name));
    else result[name] = (await readFile(file)).toString("base64");
  }
  return result;
}

test(
  "explicit Cookie pairs preserve owner/SDK HTTP+stdio wire, OpenAPI roundtrip and frozen backup/restart",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    let p = await f.call(
      "/api/projects",
      "POST",
      { name: "Cookie pairs" },
      201,
    );
    const url = "/api/projects/" + p.id;
    p = await f.call(url + "/import", "POST", { document: document(f.origin) });
    p.environments[0].variables.part = text;
    p = await f.call(url, "PUT", p);
    const saved = structuredClone(p.requests[0]);
    assert.deepEqual(saved.cookies[0].cookieSerialization, marker);
    assert.equal(f.seen.length, 0);
    const out = await f.call(url + "/export?format=openapi");
    assert.equal(
      out.paths["/pairs"].get.parameters[0]["x-local-api-cookie-dialect"],
      "cookie-pairs-v1",
    );
    let fresh = await f.call(
      "/api/projects",
      "POST",
      { name: "Cookie roundtrip" },
      201,
    );
    fresh = await f.call(`/api/projects/${fresh.id}/import`, "POST", {
      document: out,
    });
    assert.deepEqual(fresh.requests[0].cookies, saved.cookies);
    // Execute the reimport, not just a structural comparison.
    fresh.environments[0].variables.part = text;
    fresh = await f.call(`/api/projects/${fresh.id}`, "PUT", fresh);
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
    p.requests[0].cookies[0].value = JSON.stringify({
      role: "live",
      active: false,
      count: 0,
    });
    p = await f.call(url, "PUT", p);
    await f.restart();
    assert.equal(
      JSON.parse(
        (await new Store(f.root).get(p.id)).requests[0].cookies[0].value,
      ).role,
      "live",
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
      const invoke = await connect(f, kind, p.id);
      const before = (await f.call(url)).requests;
      assertRun(decode(await invoke("run_plan", { planId: frozen.id })));
      assertRun(
        decode(
          await invoke("execute_api", {
            apiId: saved.id,
            input: {
              cookies: {
                filter: { role: "temporary;=", active: false, count: 0 },
              },
            },
          }),
        ),
        cookie("temporary%3B%3D"),
      );
      assert.deepEqual((await f.call(url)).requests, before);
      const count = f.seen.length;
      for (const value of [
        "not an object",
        { role: {} },
        { ordinary: "collision" },
      ]) {
        const rejected = await invoke("execute_api", {
          apiId: saved.id,
          input: { cookies: { filter: value } },
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
  "Cookie objects interpolate parsed values and reject dynamic malformed or colliding values before network",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const [request] = importDocument(document(f.origin));
    const original = structuredClone(request);
    assertRun(
      await runPlan(
        snapshotPlan({ steps: [{ request }] }),
        { part: text },
        executeRequest,
      ),
    );
    assert.deepEqual(request, original);
    request.cookies[0].dynamic = {
      source: "fixed",
      value: { role: "dynamic;=", active: false, count: 0 },
    };
    assertRun(
      await runPlan(snapshotPlan({ steps: [{ request }] }), {}, executeRequest),
      cookie("dynamic%3B%3D"),
    );
    const count = f.seen.length;
    for (const value of [{ role: {} }, { ordinary: "collision" }]) {
      request.cookies[0].dynamic.value = value;
      const result = await runPlan(
        snapshotPlan({ steps: [{ request }] }),
        {},
        executeRequest,
      );
      assert.equal(result.status, "failed", JSON.stringify(result));
      assert.match(result.results[0].error, /Cookie对象/);
      assert.equal(f.seen.length, count);
    }
  },
);

test(
  "Cookie pairs reach real HTTP/1.1, HTTP/2 and curl; empty objects produce no pairs",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const [request] = importDocument(document(f.origin));
    request.cookies[0].value = JSON.stringify({
      role: text,
      active: false,
      count: 0,
    });
    assert.equal(
      JSON.parse((await executeRequest(request)).body).cookie,
      cookie(),
    );
    const h2 = http2.createServer();
    h2.on("stream", (stream, headers) => {
      stream.respond({ ":status": 200, "content-type": "application/json" });
      stream.end(JSON.stringify({ cookie: headers.cookie ?? null }));
    });
    await new Promise((resolve) => h2.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => h2.close(resolve)));
    const request2 = {
      ...request,
      url: `http://127.0.0.1:${h2.address().port}/h2`,
      httpVersion: "2",
    };
    assert.equal(
      JSON.parse((await executeRequest(request2)).body).cookie,
      cookie(),
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
        resolve({ error });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
    if (result.error?.code === "ENOENT") {
      t.diagnostic(
        "curl executable unavailable; HTTP transports were checked, curl is not verified",
      );
      throw result.error;
    }
    assert.ifError(result.error);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      cookie: cookie(),
      path: "/pairs",
    });
    request.cookies[0].value = "{}";
    assert.equal(
      JSON.parse((await executeRequest(request)).body).cookie,
      "ordinary=kept",
    );
    request.cookies.pop();
    assert.equal(JSON.parse((await executeRequest(request)).body).cookie, null);
  },
);

test(
  "real Cookie jar retains priority over object pairs and removes the header when enabled but empty",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const [request] = importDocument(document(f.origin));
    request.cookies[0].value = JSON.stringify({
      role: "manual",
      active: false,
      count: 0,
    });
    const conflicting = structuredClone(request);
    conflicting.headers.push({
      key: "Cookie",
      value: "raw=ignored",
      enabled: true,
    });
    await assert.rejects(executeRequest(conflicting), /Cookie Header/);
    assert.equal(f.seen.length, 0);
    const jar = new ProjectCookieJar(f.root, "cookie-fixture", "environment");
    const send = async () =>
      JSON.parse(
        (await executeRequest(request, undefined, { cookieSession: jar })).body,
      ).cookie;
    assert.equal(await send(), cookie("manual"));
    await jar.configure({ enabled: true, expectedRevision: 0 });
    assert.equal(await send(), null);
    await jar.capture(f.origin + "/", [
      "role=managed; Path=/",
      "sid=jar; Path=/",
    ]);
    assert.equal(await send(), "role=managed; sid=jar");
    const state = await jar.inspect();
    await jar.configure({ enabled: false, expectedRevision: state.revision });
    assert.equal(await send(), cookie("manual"));
  },
);

test(
  "unsupported Cookie object imports reject atomically via owner and official SDK without disk or network changes",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const p = await f.call(
      "/api/projects",
      "POST",
      { name: "Atomic cookies" },
      201,
    );
    const url = "/api/projects/" + p.id;
    const before = await new Store(f.root).get(p.id);
    const disk = await diskFiles(f.app.store.directory(p.id));
    const invalid = document(f.origin);
    invalid.paths["/bad"] = structuredClone(invalid.paths["/pairs"]);
    delete invalid.paths["/bad"].get.parameters[0][
      "x-local-api-cookie-dialect"
    ];
    invalid.paths["/bad"].get.operationId = "bad";
    await f.call(url + "/import", "POST", { document: invalid }, 400);
    for (const kind of ["http", "stdio"]) {
      const invoke = await connect(f, kind, p.id);
      for (const coverMode of ["url", "url_and_folder", "ignore", "both"]) {
        const result = await invoke("sync_openapi", {
          document: invalid,
          coverMode,
        });
        assert.equal(result.isError, true, JSON.stringify(result));
      }
    }
    assert.deepEqual(await new Store(f.root).get(p.id), before);
    assert.deepEqual(await diskFiles(f.app.store.directory(p.id)), disk);
    assert.equal(f.seen.length, 0);
  },
);

test(
  "official SDK HTTP and stdio replace Cookie source templates without defining unused variables",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      store = new Store(f.root),
      p = await store.create("Cookie replacement without old variables");
    p.requests = [];
    for (const location of ["parameter", "example", "default"]) {
      const source = document(f.origin),
        parameter = source.paths["/pairs"].get.parameters[0];
      parameter.example = { role: "{{unused}}", active: false, count: 0 };
      if (location !== "parameter") {
        parameter.schema[location] = parameter.example;
        delete parameter.example;
      }
      p.requests.push(importDocument(source)[0]);
    }
    await store.save(p);
    const original = (await store.get(p.id)).requests;
    for (const kind of ["http", "stdio"]) {
      const invoke = await connect(f, kind, p.id);
      for (const request of original) {
        const before = f.seen.length;
        const failure = decode(
          await invoke("execute_api", { apiId: request.id }),
        );
        assert.equal(failure.status, "failed", JSON.stringify(failure));
        assert.match(failure.results[0].error, /未定义变量: unused/);
        assert.equal(f.seen.length, before);
        const result = decode(
          await invoke("execute_api", {
            apiId: request.id,
            input: {
              cookies: {
                filter: { role: "replacement;=", active: false, count: 0 },
              },
            },
          }),
        );
        assertRun(result, cookie("replacement%3B%3D"));
        assert.equal(f.seen.length, before + 1);
        assert.deepEqual(
          result.results[0].request.openapiOperation,
          request.openapiOperation,
        );
        assert.deepEqual(
          result.results[0].request.cookies[0].schema,
          request.cookies[0].schema,
        );
      }
    }
    assert.deepEqual((await new Store(f.root).get(p.id)).requests, original);
    assert.equal(
      Object.hasOwn(
        (await store.get(p.id)).environments[0].variables,
        "unused",
      ),
      false,
    );
  },
);
