// Authoring validation is syntax-only locally. Run this complete script-free
// owner/CLI/SDK network and persistence workflow in ordinary GitHub CI.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { importIntoProject, toCurl } from "../src/core.mjs";

const cliPath = fileURLToPath(
  new URL("../scripts/run-plan.mjs", import.meta.url),
);
const mcpPath = fileURLToPath(new URL("../src/mcp.mjs", import.meta.url));
const part = 'quo"te\\中文,&+/%';
const parts = ["a,b", "c&d", "+/%", part];
const encoded = [
  "a%2Cb",
  "c%26d",
  "%2B%2F%25",
  "quo%22te%5C%E4%B8%AD%E6%96%87%2C%26%2B%2F%25",
];
const repeated = encoded.map((value) => "q=" + value).join("&");
const csv = "q=" + encoded.join(",");
const operation = (parameter, id) => ({
  operationId: id,
  summary: id,
  parameters: [parameter],
  responses: { 200: { description: "Raw query echo" } },
});
function openapi(origin) {
  const query = {
    name: "q",
    in: "query",
    description: "Array element boundaries",
    schema: { type: "array", items: { type: "string" } },
    example: ["a,b", "c&d", "+/%", "{{part}}"],
  };
  return {
    openapi: "3.0.3",
    info: { title: "Query array workflow", version: "1" },
    servers: [{ url: origin }],
    paths: {
      "/multi": { get: operation(query, "multi") },
      "/csv": { get: operation({ ...query, explode: false }, "csv") },
      "/empty": { get: operation({ ...query, example: [] }, "empty") },
      "/numbers": {
        get: operation(
          {
            name: "q",
            in: "query",
            schema: {
              type: "array",
              items: { type: "integer" },
              default: [0, 2, -3],
            },
          },
          "numbers",
        ),
      },
      "/booleans": {
        get: operation(
          {
            name: "q",
            in: "query",
            schema: { type: "array", items: { type: "boolean" } },
            example: [false, true],
          },
          "booleans",
        ),
      },
    },
  };
}
function swagger(host) {
  const query = {
    name: "q",
    in: "query",
    type: "array",
    items: { type: "string" },
    default: ["a,b", "c&d", "+/%", "{{part}}"],
  };
  return {
    swagger: "2.0",
    info: { title: "Swagger query arrays", version: "1" },
    host,
    schemes: ["http"],
    paths: {
      "/swagger-multi": {
        get: operation(
          { ...query, collectionFormat: "multi" },
          "swagger-multi",
        ),
      },
      "/swagger-csv": { get: operation(query, "swagger-csv") },
    },
  };
}
const expected = new Map([
  ["/multi", { raw: repeated, values: parts, mode: "multi" }],
  ["/csv", { raw: csv, values: parts, mode: "csv" }],
  ["/empty", { raw: "", values: [], mode: "multi" }],
  [
    "/numbers",
    { raw: "q=0&q=2&q=-3", values: ["0", "2", "-3"], mode: "multi" },
  ],
  [
    "/booleans",
    { raw: "q=false&q=true", values: ["false", "true"], mode: "multi" },
  ],
  ["/swagger-multi", { raw: repeated, values: parts, mode: "multi" }],
  ["/swagger-csv", { raw: csv, values: parts, mode: "csv" }],
]);
function assertEntry(entry, specification = expected.get(entry.path)) {
  assert(specification, "Unexpected captured path: " + entry.path);
  assert.equal(entry.method, "GET");
  assert.equal(entry.authorization, null);
  assert.equal(entry.raw, specification.raw);
  // Independent receiver decoding: split CSV delimiters before decoding, so an
  // encoded comma inside an element cannot masquerade as an array separator.
  const values =
    specification.mode === "csv"
      ? entry.raw.slice("q=".length).split(",").map(decodeURIComponent)
      : new URLSearchParams(entry.raw).getAll("q");
  assert.deepEqual(values, specification.values);
}
function assertRun(run, count = expected.size) {
  assert.equal(run.status, "passed", JSON.stringify(run));
  assert.equal(run.results.length, count);
  for (const result of run.results) {
    assert.equal(result.status, "passed", JSON.stringify(result));
    assert.equal(result.response.status, 200);
    assertEntry(JSON.parse(result.response.body));
  }
}
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "query-array-flow-"));
  const seen = [],
    clients = new Set();
  const origin = http.createServer((request, response) => {
    const at = request.url.indexOf("?");
    const entry = {
      method: request.method,
      path: at < 0 ? request.url : request.url.slice(0, at),
      raw: at < 0 ? "" : request.url.slice(at + 1),
      authorization: request.headers.authorization ?? null,
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
      if (timedOut) reject(Error("Query array CLI deadline: " + stderr));
      else resolve({ code, stdout, stderr });
    });
  });
}
async function connect(f, kind, projectId) {
  const client = new Client(
    { name: "query-array-workflow", version: "1" },
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
  "query arrays retain element boundaries through owner import, frozen plan, CLI, OpenAPI, backup and SDK HTTP/stdio",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    let project = await f.call(
      "/api/projects",
      "POST",
      { name: "Query arrays" },
      201,
    );
    for (const document of [openapi(f.origin), swagger(f.host)]) {
      const unchanged = structuredClone(document);
      project = await f.call(`/api/projects/${project.id}/import`, "POST", {
        document,
      });
      assert.deepEqual(document, unchanged);
    }
    assert.equal(project.requests.length, expected.size);
    assert.equal(f.seen.length, 0);
    for (const request of project.requests) {
      assert.equal(request.query.length, 1);
      assert.equal(request.query[0].querySerialization.version, 1);
      assert.equal(request.query[0].querySerialization.style, "form");
      assert(Array.isArray(JSON.parse(request.query[0].value)));
    }
    project.environments[0].variables.part = part;
    project = await f.call(`/api/projects/${project.id}`, "PUT", project);
    const exported = await f.call(
      `/api/projects/${project.id}/export?format=openapi`,
    );
    for (const [route, item] of Object.entries(exported.paths)) {
      assert.equal(item.get.parameters.length, 1, route);
      const parameter = item.get.parameters[0];
      assert.equal(parameter.name, "q");
      assert.equal(parameter.schema.type, "array");
      assert.equal(parameter.style, "form");
      assert.equal(parameter.explode, expected.get(route).mode !== "csv");
      assert(Array.isArray(parameter.example));
    }
    let roundtrip = await f.call(
      "/api/projects",
      "POST",
      { name: "Roundtrip" },
      201,
    );
    roundtrip = await f.call(`/api/projects/${roundtrip.id}/import`, "POST", {
      document: exported,
    });
    for (const request of roundtrip.requests) {
      const original = project.requests.find(
        (row) => row.sourceOperationId === request.sourceOperationId,
      );
      assert.deepEqual(request.query, original.query);
    }
    roundtrip.environments[0].variables.part = part;
    roundtrip = await f.call(`/api/projects/${roundtrip.id}`, "PUT", roundtrip);
    const planInput = (p) => ({
      name: "Frozen arrays",
      environmentId: p.environments[0].id,
      steps: p.requests.map((request) => ({ request })),
    });
    const plan = await f.call(
      `/api/projects/${project.id}/plans`,
      "POST",
      planInput(project),
    );
    const roundtripPlan = await f.call(
      `/api/projects/${roundtrip.id}/plans`,
      "POST",
      planInput(roundtrip),
    );
    project = await f.call(`/api/projects/${project.id}`);
    const frozen = structuredClone(
      project.plans.find((entry) => entry.id === plan.id),
    );
    const multi = project.requests.find(
      (request) => request.sourceOperationId === "multi",
    );
    multi.query[0].value = '["live edited"]';
    project = await f.call(`/api/projects/${project.id}`, "PUT", project);
    await f.restart();
    assert.deepEqual(
      (await f.call(`/api/projects/${project.id}`)).plans.find(
        (entry) => entry.id === plan.id,
      ),
      frozen,
    );
    assert.equal(f.seen.length, 0);
    const ownerRun = await f.call(`/api/projects/${project.id}/run`, "POST", {
      planId: plan.id,
    });
    assertRun(ownerRun);
    assert.equal(ownerRun.recordSaved, true);
    assertRun(
      await f.call(`/api/projects/${roundtrip.id}/run`, "POST", {
        planId: roundtripPlan.id,
      }),
    );
    const output = path.join(f.root, "array-cli.json");
    const cli = await invokeCLI(f.root, project.id, plan.id, output);
    assert.equal(cli.code, 0, cli.stderr + "\n" + cli.stdout);
    const cliRun = JSON.parse(cli.stdout);
    assertRun(cliRun);
    assert.equal(cliRun.recordSaved, true);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), cliRun);
    assert.equal(f.seen.length, expected.size * 3);
    const curlRequest = structuredClone(
      roundtrip.requests.find((request) => request.sourceOperationId === "csv"),
    );
    curlRequest.query[0].value = JSON.stringify(parts);
    assert(toCurl(curlRequest).includes(f.origin + "/csv?" + csv));
    const backup = await f.call(`/api/projects/${project.id}/export`);
    const restored = await f.call(
      "/api/restore",
      "POST",
      { document: backup },
      201,
    );
    assert.notEqual(restored.id, project.id);
    assert.deepEqual(restored.plans, backup.plans);
    assert.deepEqual(restored.runs, backup.runs);
    await f.restart();
    assert.deepEqual(
      (await f.call(`/api/projects/${restored.id}`)).plans,
      backup.plans,
    );
    const untouched = await f.call(`/api/projects/${roundtrip.id}`);
    for (const kind of ["http", "stdio"]) {
      const target = kind === "http" ? project.id : restored.id;
      const sdk = await connect(f, kind, target);
      const before = f.seen.length;
      const denied = await sdk.invoke("run_plan", {
        projectId: roundtrip.id,
        planId: roundtripPlan.id,
      });
      assert.equal(denied.isError, true);
      assert.equal(f.seen.length, before);
      const run = decode(await sdk.invoke("run_plan", { planId: plan.id }));
      assertRun(run);
      assert.equal(run.recordSaved, true);
      const detail = decode(
        await sdk.invoke("get_execution_result", { runId: run.id }),
      );
      assert.equal(detail.source, "mcp");
      assert.deepEqual(detail.results, run.results);
      assert(
        decode(
          await sdk.invoke("list_execution_runs", {
            scope: "flow",
            planId: plan.id,
            source: "mcp",
          }),
        ).some((entry) => entry.id === run.id),
      );
      const deniedRead = await sdk.invoke("get_execution_result", {
        projectId: roundtrip.id,
        runId: ownerRun.id,
      });
      assert.equal(deniedRead.isError, true);
      assert.equal(f.seen.length, before + expected.size);
      const beforeOverride = await f.call(`/api/projects/${target}`);
      const overridden = decode(
        await sdk.invoke("execute_api", {
          apiId: multi.id,
          input: { query: { q: ["override,one", "two&+"] } },
        }),
      );
      assert.equal(overridden.status, "passed", JSON.stringify(overridden));
      assertEntry(JSON.parse(overridden.results[0].response.body), {
        raw: "q=override%2Cone&q=two%26%2B",
        values: ["override,one", "two&+"],
        mode: "multi",
      });
      assert.deepEqual(
        (await f.call(`/api/projects/${target}`)).requests,
        beforeOverride.requests,
      );
      const afterValid = await f.call(`/api/projects/${target}`);
      const count = f.seen.length;
      const invalid = await sdk.invoke("execute_api", {
        apiId: multi.id,
        input: { query: { q: "not an array" } },
      });
      assert.equal(invalid.isError, true);
      assert.equal(f.seen.length, count);
      assert.deepEqual(await f.call(`/api/projects/${target}`), afterValid);
      await sdk.client.close();
      f.clients.delete(sdk.client);
    }
    assert.deepEqual(await f.call(`/api/projects/${roundtrip.id}`), untouched);
    const latest = await f.call(`/api/projects/${restored.id}`);
    await f.restart();
    const persisted = await f.call(`/api/projects/${restored.id}`);
    assert.deepEqual(persisted.runs, latest.runs);
    assert.deepEqual(persisted.history, latest.history);
    assert.deepEqual(persisted.plans, backup.plans);
  },
);

test(
  "query array import and MCP sync reject unsupported mixed batches atomically, retain scopes and raw query spelling",
  { timeout: 25000 },
  async (t) => {
    const f = await fixture(t);
    let project = await f.call(
      "/api/projects",
      "POST",
      { name: "Query atomicity" },
      201,
    );
    project = await f.call(`/api/projects/${project.id}/import`, "POST", {
      document: openapi(f.origin),
    });
    project.environments[0].variables.part = part;
    const savedRequest = structuredClone(project.requests[0]);
    project.cases = [
      {
        name: "Saved array case",
        sourceRequestId: savedRequest.id,
        request: savedRequest,
      },
    ];
    project.plans = [
      {
        name: "Saved array plan",
        environmentId: project.environments[0].id,
        steps: [{ request: structuredClone(savedRequest) }],
      },
    ];
    project = await f.call(`/api/projects/${project.id}`, "PUT", project);
    const before = await f.call(`/api/projects/${project.id}`),
      disk = await diskFiles(f.app.store.directory(project.id));
    const invalidParameters = [
      {
        name: "bad",
        in: "query",
        schema: { type: "array", items: { type: "string" } },
        example: ["x"],
        style: "spaceDelimited",
      },
      {
        name: "bad",
        in: "query",
        schema: { type: "array", items: { type: "string" } },
        example: ["x"],
        allowReserved: true,
      },
      {
        name: "bad",
        in: "query",
        schema: { type: "array", items: { type: "object" } },
        example: [{ x: 1 }],
      },
      {
        name: "bad",
        in: "query",
        schema: { type: "array", items: { type: "array" } },
        example: [["x"]],
      },
      {
        name: "bad",
        in: "query",
        schema: { type: "array", items: { type: "string" } },
        example: [""],
      },
      {
        name: "bad",
        in: "query",
        content: {
          "application/json": {
            schema: { type: "array", items: { type: "string" } },
            example: ["x"],
          },
        },
      },
    ];
    const arrayParameter = {
      name: "bad",
      in: "query",
      schema: { type: "array", items: { type: "string" } },
      example: ["x"],
    };
    invalidParameters.push(
      { ...arrayParameter, style: null },
      { ...arrayParameter, explode: null },
      { ...arrayParameter, collectionFormat: null },
      {
        ...arrayParameter,
        schema: { type: ["array", "null"], items: { type: "string" } },
      },
      {
        ...arrayParameter,
        schema: {
          ...arrayParameter.schema,
          oneOf: [{ type: "array", items: { type: "string" } }],
        },
      },
      {
        ...arrayParameter,
        schema: {
          ...arrayParameter.schema,
          items: { type: ["string", "null"] },
        },
      },
      { ...arrayParameter, examples: { competing: { value: ["y"] } } },
    );
    const invalidDocuments = invalidParameters.map((parameter) => {
      const source = openapi(f.origin);
      source.paths["/bad"] = { get: operation(parameter, "bad") };
      return source;
    });
    const badSwagger = swagger(new URL(f.origin).host);
    badSwagger.paths["/bad"] = {
      get: operation(
        {
          name: "bad",
          in: "query",
          type: "array",
          items: { type: "string" },
          default: ["x"],
          collectionFormat: null,
        },
        "bad",
      ),
    };
    invalidDocuments.push(badSwagger);
    for (const source of invalidDocuments) {
      const copy = structuredClone(before),
        original = structuredClone(source);
      assert.throws(() => importIntoProject(copy, source));
      assert.deepEqual(copy, before);
      assert.deepEqual(source, original);
      await f.call(
        `/api/projects/${project.id}/import`,
        "POST",
        { document: source },
        400,
      );
      assert.deepEqual(await f.call(`/api/projects/${project.id}`), before);
      assert.deepEqual(
        await diskFiles(f.app.store.directory(project.id)),
        disk,
      );
      assert.equal(f.seen.length, 0);
    }
    // All stored request-bearing surfaces must reject malformed metadata before
    // any project/configuration revision or persisted file is changed.
    assert.ok(Number.isInteger(before.configRevision));
    for (const select of [
      (p) => p.requests[0],
      (p) => p.cases[0].request,
      (p) => p.plans[0].steps[0].request,
    ]) {
      const malformed = structuredClone(before);
      select(malformed).query[0].querySerialization.explode = "true";
      await f.call(`/api/projects/${project.id}`, "PUT", malformed, 400);
      const preserved = await f.call(`/api/projects/${project.id}`);
      assert.equal(preserved.configRevision, before.configRevision);
      assert.deepEqual(preserved, before);
      assert.deepEqual(
        await diskFiles(f.app.store.directory(project.id)),
        disk,
      );
      assert.equal(f.seen.length, 0);
    }
    const sdkMode = structuredClone(before);
    sdkMode.requests[0].scriptURLMode = "sdk";
    await f.call(`/api/projects/${project.id}`, "PUT", sdkMode, 400);
    assert.deepEqual(await f.call(`/api/projects/${project.id}`), before);
    assert.deepEqual(await diskFiles(f.app.store.directory(project.id)), disk);
    const request = structuredClone(
      project.requests.find((entry) => entry.sourceOperationId === "multi"),
    );
    request.url += "?keep=%2f+%2520";
    request.query[0].value = '["a,b","c&d"]';
    const result = await f.call(`/api/projects/${project.id}/execute`, "POST", {
      request,
    });
    assert.equal(result.outcome, "passed", JSON.stringify(result));
    assert.equal(JSON.parse(result.body).raw, "keep=%2f+%2520&q=a%2Cb&q=c%26d");
    const dynamic = structuredClone(request);
    dynamic.query[0].dynamic = {
      source: "fixed",
      value: ["dynamic,one", "two&+"],
    };
    const dynamicResult = await f.call(
      `/api/projects/${project.id}/execute`,
      "POST",
      { request: dynamic },
    );
    assert.equal(
      dynamicResult.outcome,
      "passed",
      JSON.stringify(dynamicResult),
    );
    assert.equal(
      JSON.parse(dynamicResult.body).raw,
      "keep=%2f+%2520&q=dynamic%2Cone&q=two%26%2B",
    );
    const disabled = structuredClone(request);
    disabled.query[0].enabled = false;
    const disabledResult = await f.call(
      `/api/projects/${project.id}/execute`,
      "POST",
      { request: disabled },
    );
    assert.equal(
      disabledResult.outcome,
      "passed",
      JSON.stringify(disabledResult),
    );
    assert.equal(JSON.parse(disabledResult.body).raw, "keep=%2f+%2520");
    const sdk = await connect(f, "http", project.id);
    const count = f.seen.length;
    const syncSource = openapi(f.origin);
    const synced = decode(
      await sdk.invoke("sync_openapi", {
        document: syncSource,
        coverMode: "url",
      }),
    );
    assert.equal(synced.length, 5);
    assert.equal(f.seen.length, count);
    assert.equal(
      synced.find((entry) => entry.sourceOperationId === "multi").id,
      project.requests.find((entry) => entry.sourceOperationId === "multi").id,
    );
    const syncedMulti = synced.find(
      (entry) => entry.sourceOperationId === "multi",
    );
    const syncRun = decode(
      await sdk.invoke("execute_api", { apiId: syncedMulti.id }),
    );
    assertRun(syncRun, 1);
    const saved = await f.call(`/api/projects/${project.id}`),
      savedDisk = await diskFiles(f.app.store.directory(project.id));
    syncSource.paths["/bad"] = { get: operation(invalidParameters[0], "bad") };
    const failure = await sdk.invoke("sync_openapi", {
      document: syncSource,
      coverMode: "url",
    });
    assert.equal(failure.isError, true);
    assert.deepEqual(await f.call(`/api/projects/${project.id}`), saved);
    assert.deepEqual(
      await diskFiles(f.app.store.directory(project.id)),
      savedDisk,
    );
    assert.equal(f.seen.length, count + 1);
    await sdk.client.close();
    f.clients.delete(sdk.client);
  },
);
