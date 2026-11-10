import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import http2 from "node:http2";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store, executeRequest } from "../src/runtime.mjs";
import { importDocument, toCurl, runPlan, snapshotPlan } from "../src/core.mjs";
const cliPath = fileURLToPath(
  new URL("../scripts/run-plan.mjs", import.meta.url),
);
const mcpPath = fileURLToPath(new URL("../src/mcp.mjs", import.meta.url));
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
function document(origin) {
  const schema = {
    type: "object",
    properties: {
      role: { type: "string" },
      active: { type: "boolean" },
      count: { type: "integer" },
    },
  };
  return {
    openapi: "3.1.0",
    info: { title: "Header object wire", version: "1" },
    servers: [{ url: origin }],
    paths: Object.fromEntries(
      [false, true].map((explode) => [
        explode ? "/explode" : "/simple",
        {
          get: {
            operationId: explode ? "explode" : "simple",
            parameters: [
              {
                in: "header",
                name: "X-Filter",
                style: "simple",
                explode,
                schema,
                example: { role: "{{part}}", active: false, count: 0 },
              },
              {
                in: "header",
                name: "X-Ordinary",
                schema: { type: "string" },
                example: "kept",
              },
              {
                in: "cookie",
                name: "ordinary",
                schema: { type: "string" },
                example: "cookie",
              },
            ],
            responses: { 200: { description: "Echo" } },
          },
        },
      ]),
    ),
  };
}
const text = 'quo"te\\中文,&=+/%';
const encodedText = "quo%22te%5C%E4%B8%AD%E6%96%87%2C%26%3D%2B%2F%25";
const expected = (explode, value = encodedText) => ({
  path: explode ? "/explode" : "/simple",
  object: explode
    ? `role=${value},active=false,count=0`
    : `role,${value},active,false,count,0`,
  ordinary: "kept",
  cookie: "ordinary=cookie",
});
function assertRun(run, value = encodedText) {
  assert.equal(run.status, "passed", JSON.stringify(run.results));
  assert.equal(run.results.length, 2);
  for (const [index, result] of run.results.entries()) {
    assert.equal(result.status, "passed", JSON.stringify(result));
    assert.equal(result.response.status, 200);
    assert.deepEqual(
      JSON.parse(result.response.body),
      expected(index === 1, value),
    );
  }
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "header-object-flow-"));
  const seen = [],
    clients = new Set();
  const origin = http.createServer((request, response) => {
    const entry = {
      path: request.url,
      object: request.headers["x-filter"] ?? null,
      ordinary: request.headers["x-ordinary"] ?? null,
      cookie: request.headers.cookie ?? null,
    };
    seen.push(entry);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(entry));
  });
  await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
  let app = await createApp({ root, port: 0 });
  const closeApp = async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
    await closeApp();
    origin.closeAllConnections();
    await new Promise((resolve) => origin.close(resolve));
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
    const output = await response.json();
    assert.equal(response.status, status, JSON.stringify(output));
    return output;
  };
  return {
    root,
    seen,
    clients,
    call,
    host: "127.0.0.1:" + origin.address().port,
    origin: "http://127.0.0.1:" + origin.address().port,
    get app() {
      return app;
    },
    async restart() {
      await closeApp();
      app = await createApp({ root, port: 0 });
    },
  };
}
async function diskFiles(directory, prefix = "") {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const key = path.join(prefix, entry.name),
      location = path.join(directory, entry.name);
    if (entry.isDirectory())
      Object.assign(result, await diskFiles(location, key));
    else result[key] = (await readFile(location)).toString("base64");
  }
  return result;
}
async function invokeCLI(root, projectId, planId, output) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [cliPath, "--project", projectId, "--plan", planId, "--output", output],
      {
        env: { ...process.env, LOCAL_API_DATA: root },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "",
      timedOut = false;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 10000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(Error("Header object CLI deadline: " + stderr));
      else resolve({ code, stdout, stderr });
    });
  });
}
async function connect(f, kind, projectId) {
  const client = new Client(
    { name: "header-object-workflow", version: "1" },
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
  return {
    client,
    invoke: (name, args = {}) =>
      client.callTool({
        name: "localapi_" + name,
        arguments: { projectId, ...args },
      }),
  };
}

test(
  "Header objects retain exact wire through owner/CLI/SDK HTTP+stdio, OpenAPI, backups and frozen Store reopen",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    let project = await f.call(
      "/api/projects",
      "POST",
      { name: "Header objects" },
      201,
    );
    const url = "/api/projects/" + project.id;
    project = await f.call(url + "/import", "POST", {
      document: document(f.origin),
    });
    project.environments[0].variables.part = text;
    project = await f.call(url, "PUT", project);
    assert.equal(f.seen.length, 0);
    const saved = structuredClone(project.requests);
    const exported = await f.call(url + "/export?format=openapi");
    let fresh = await f.call(
      "/api/projects",
      "POST",
      { name: "Roundtrip objects" },
      201,
    );
    fresh = await f.call(`/api/projects/${fresh.id}/import`, "POST", {
      document: exported,
    });
    for (let i = 0; i < saved.length; i++)
      assert.deepEqual(fresh.requests[i].headers, saved[i].headers);
    const plan = await f.call(url + "/plans", "POST", {
      name: "Frozen objects",
      environmentId: project.environments[0].id,
      steps: saved.map((request) => ({ request })),
    });
    project = await f.call(url);
    project.requests[0].headers[0].value = JSON.stringify({
      role: "live",
      active: false,
      count: 0,
    });
    await f.call(url, "PUT", project);
    await f.restart();
    assert.equal(
      JSON.parse(
        (await new Store(f.root).get(project.id)).requests[0].headers[0].value,
      ).role,
      "live",
    );
    assertRun(await f.call(url + "/run", "POST", { planId: plan.id }));
    const output = path.join(f.root, "header-cli.json");
    const cli = await invokeCLI(f.root, project.id, plan.id, output);
    assert.equal(cli.code, 0, cli.stdout + cli.stderr);
    assertRun(JSON.parse(cli.stdout));
    assert.deepEqual(
      JSON.parse(await readFile(output, "utf8")),
      JSON.parse(cli.stdout),
    );
    for (let index = 0; index < saved.length; index++) {
      const request = structuredClone(saved[index]);
      request.headers[0].value = JSON.stringify({
        role: text,
        active: false,
        count: 0,
      });
      const { curl } = await f.call(url + "/curl", "POST", { request });
      assert(curl.includes("'x-filter: " + expected(index === 1).object + "'"));
      assert.equal(curl, toCurl(request));
      const response = await f.call(url + "/execute", "POST", { request });
      assert.deepEqual(JSON.parse(response.body), expected(index === 1));
    }
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
        planId: plan.id,
      }),
    );
    const untouched = await new Store(f.root).get(fresh.id);
    for (const kind of ["http", "stdio"]) {
      const sdk = await connect(f, kind, project.id);
      const before = (await f.call(url)).requests;
      assertRun(decode(await sdk.invoke("run_plan", { planId: plan.id })));
      const input = { role: "temporary,&=", active: false, count: 0 };
      const run = decode(
        await sdk.invoke("execute_api", {
          apiId: saved[1].id,
          input: { headers: { "x-filter": input } },
        }),
      );
      assert.equal(run.status, "passed", JSON.stringify(run));
      assert.deepEqual(
        JSON.parse(run.results[0].response.body),
        expected(true, "temporary%2C%26%3D"),
      );
      assert.deepEqual((await f.call(url)).requests, before);
      const count = f.seen.length;
      const bad = await sdk.invoke("execute_api", {
        apiId: saved[1].id,
        input: { headers: { "X-Filter": { role: {} } } },
      });
      assert.equal(bad.isError, true);
      assert.equal(f.seen.length, count);
      const denied = await sdk.invoke("run_plan", {
        projectId: fresh.id,
        planId: plan.id,
      });
      assert.equal(denied.isError, true);
      assert.equal(f.seen.length, count);
    }
    assert.deepEqual(await new Store(f.root).get(fresh.id), untouched);
  },
);

test(
  "Header object scripts preserve metadata and dynamic values are encoded after resolution",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const [request] = importDocument(document(f.origin));
    request.headers[0].dynamic = {
      source: "fixed",
      value: { role: "dynamic", active: false, count: 0 },
    };
    let result = await runPlan(
      snapshotPlan({ steps: [{ request }] }),
      { part: text },
      executeRequest,
    );
    assert.equal(result.status, "passed", JSON.stringify(result.results));
    assert.deepEqual(
      JSON.parse(result.results[0].response.body),
      expected(false, "dynamic"),
    );
    delete request.headers[0].dynamic;
    request.beforeScript = `pm.request.headers.upsert({key: 'X-Filter', value: JSON.stringify({role: 'script,&=', active: false, count: 0})});`;
    result = await runPlan(
      snapshotPlan({ steps: [{ request }] }),
      { part: text },
      executeRequest,
    );
    assert.equal(result.status, "passed", JSON.stringify(result.results));
    assert.deepEqual(
      JSON.parse(result.results[0].response.body),
      expected(false, "script%2C%26%3D"),
    );
    assert.equal(
      result.results[0].request.headers[0].headerSerialization.version,
      1,
    );
    request.beforeScript = `pm.request.headers.upsert({key: 'X-Filter', value: '{"role":{}}'});`;
    const count = f.seen.length;
    result = await runPlan(
      snapshotPlan({ steps: [{ request }] }),
      { part: text },
      executeRequest,
    );
    assert.equal(result.status, "failed");
    assert.equal(f.seen.length, count);
  },
);

test(
  "mixed supported/unsupported Header object imports reject atomically without durable writes or requests",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const project = await f.call(
      "/api/projects",
      "POST",
      { name: "Atomic objects" },
      201,
    );
    const url = "/api/projects/" + project.id;
    const source = document(f.origin);
    source.paths["/explode"].get.parameters[0].example = { nested: {} };
    const before = await new Store(f.root).get(project.id);
    const disk = await diskFiles(f.app.store.directory(project.id));
    await f.call(url + "/import", "POST", { document: source }, 400);
    for (const kind of ["http", "stdio"]) {
      const sdk = await connect(f, kind, project.id);
      for (const coverMode of ["url", "url_and_folder", "ignore", "both"]) {
        const result = await sdk.invoke("sync_openapi", {
          document: source,
          coverMode,
        });
        assert.equal(result.isError, true);
      }
    }
    assert.deepEqual(await new Store(f.root).get(project.id), before);
    assert.deepEqual(await diskFiles(f.app.store.directory(project.id)), disk);
    assert.equal(f.seen.length, 0);
  },
);

test(
  "empty object and mixed ordinary/object headers reach HTTP/1.1 and HTTP/2 without coercion",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const [request] = importDocument(document(f.origin));
    request.headers[0].value = "{}";
    let response = await executeRequest(request);
    assert.equal(JSON.parse(response.body).object, "");
    request.headers[0].value = '{"role":"value"}';
    request.headers.push({ key: "x-filter", value: "ordinary", enabled: true });
    response = await executeRequest(request);
    assert.equal(JSON.parse(response.body).object, "role,value, ordinary");
    const peer = http2.createServer();
    peer.on("stream", (stream, headers) => {
      stream.respond({ ":status": 200, "content-type": "application/json" });
      stream.end(JSON.stringify(headers));
    });
    await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => peer.close(resolve)));
    request.url = `http://127.0.0.1:${peer.address().port}/h2`;
    request.httpVersion = "2";
    request.headers.pop();
    request.headers[0].value = JSON.stringify({
      role: text,
      active: false,
      count: 0,
    });
    response = await executeRequest(request);
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body)["x-filter"], expected(false).object);
  },
);

test(
  "generated cURL sends identical Header object bytes through the real curl executable",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const [request] = importDocument(document(f.origin));
    request.headers[0].value = JSON.stringify({
      role: text,
      active: false,
      count: 0,
    });
    // This fixture's generated command has no escaped apostrophes. Decode its
    // quoted arguments and execute directly, without shell or an alternate codec.
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
      t.skip("curl executable not installed");
      return;
    }
    assert.ifError(result.error);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected(false));
  },
);

test(
  "PR162 Header const/enum intersections preserve exact wire through owner export/reimport and Store reopen",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const source = document(f.origin);
    delete source.paths["/explode"];
    const parameter = source.paths["/simple"].get.parameters[0];
    parameter.schema = {
      type: "object",
      properties: {
        role: { type: "string", const: "admin", enum: ["admin", "member"] },
      },
      const: { role: "admin" },
      enum: [{ role: "admin" }, { role: "member" }],
    };
    parameter.example = { role: "admin" };
    const first = await f.call(
      "/api/projects",
      "POST",
      { name: "Header intersections" },
      201,
    );
    await f.call(`/api/projects/${first.id}/import`, "POST", {
      document: source,
    });
    const before = await new Store(f.root).get(first.id);
    const exported = await f.call(
      `/api/projects/${first.id}/export?format=openapi`,
    );
    const schema = exported.paths["/simple"].get.parameters[0].schema;
    assert.deepEqual(schema.allOf, [{ enum: [{ role: "admin" }] }]);
    assert.deepEqual(schema.properties.role.allOf, [{ enum: ["admin"] }]);
    const second = await f.call(
      "/api/projects",
      "POST",
      { name: "Header intersections roundtrip" },
      201,
    );
    await f.call(`/api/projects/${second.id}/import`, "POST", {
      document: exported,
    });
    await f.restart();
    for (const projectId of [first.id, second.id]) {
      const saved = await new Store(f.root).get(projectId);
      const response = await f.call(
        `/api/projects/${projectId}/execute`,
        "POST",
        { request: saved.requests[0] },
      );
      assert.equal(response.status, 200);
      assert.deepEqual(JSON.parse(response.body), {
        path: "/simple",
        object: "role,admin",
        ordinary: "kept",
        cookie: "ordinary=cookie",
      });
    }
    assert.deepEqual(
      (await new Store(f.root).get(first.id)).requests,
      before.requests,
    );
    assert.equal(f.seen.length, 2);
  },
);
