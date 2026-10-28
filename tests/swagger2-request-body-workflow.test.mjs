// Ordinary CI only during this feature's implementation. Local checks must use
// swagger2-request-body.test.mjs instead, which does not import core or the VM.
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
import { importIntoProject } from "../src/core.mjs";

const cliPath = fileURLToPath(
  new URL("../scripts/run-plan.mjs", import.meta.url),
);
const mcpPath = fileURLToPath(new URL("../src/mcp.mjs", import.meta.url));

const form = (name, type, extra = {}) => ({
  name,
  in: "formData",
  type,
  ...extra,
});
const body = (schema, extra = {}) => ({
  name: "payload",
  in: "body",
  schema,
  ...extra,
});
const operation = (parameters, extra = {}) => ({
  parameters,
  responses: { 200: { description: "Captured", schema: { type: "object" } } },
  ...extra,
});
function document(host) {
  const scalarFields = [
    form("person", "string", {
      default: "{{person}}",
      required: true,
      description: "Person",
      minLength: 1,
    }),
    form("enabled", "boolean", { default: false }),
    form("count", "integer", { default: 0, minimum: 0 }),
    form("empty", "string", { default: "" }),
  ];
  return {
    swagger: "2.0",
    info: { title: "Swagger body workflow", version: "1" },
    host,
    basePath: "/v1",
    schemes: ["http"],
    consumes: ["application/json"],
    produces: ["application/json"],
    definitions: {
      Payload: {
        type: "object",
        properties: {
          person: { type: "string" },
          enabled: { type: "boolean" },
          count: { type: "integer" },
          literal: { type: "object" },
        },
        required: ["person"],
        example: {
          person: "{{person}}",
          enabled: false,
          count: 0,
          literal: { $ref: "#/literal-data" },
        },
      },
    },
    parameters: {
      Payload: body(
        { $ref: "#/definitions/Payload" },
        { required: true, description: "JSON payload", "x-source": "kept" },
      ),
    },
    paths: {
      "/json": {
        parameters: [body({ example: { discarded: "path-level" } })],
        post: operation([{ $ref: "#/parameters/Payload" }], {
          summary: "JSON",
          operationId: "json",
          consumes: ["text/plain", "application/json"],
        }),
      },
      "/text": {
        post: operation(
          [
            body(
              { type: "string", example: "hello {{person}} & +" },
              { description: "Text payload" },
            ),
          ],
          {
            summary: "Text",
            operationId: "text",
            consumes: ["text/plain; charset=utf-8"],
          },
        ),
      },
      "/form": {
        post: operation(scalarFields, {
          summary: "Form",
          operationId: "form",
          consumes: ["application/x-www-form-urlencoded"],
        }),
      },
      "/multipart": {
        post: operation(scalarFields, {
          summary: "Multipart",
          operationId: "multipart",
          consumes: ["multipart/form-data"],
        }),
      },
      "/file": {
        post: operation(
          [
            form("attachment", "file", {
              required: true,
              description: "Select explicitly",
            }),
          ],
          {
            summary: "File",
            operationId: "file",
            consumes: ["multipart/form-data"],
          },
        ),
      },
    },
  };
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "swagger2-body-"));
  const seen = [];
  const origin = http.createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const contentType = req.headers["content-type"] || "";
      let value = raw;
      if (contentType.startsWith("application/json")) value = JSON.parse(raw);
      if (contentType.startsWith("application/x-www-form-urlencoded"))
        value = [...new URLSearchParams(raw)];
      if (contentType.startsWith("multipart/form-data")) {
        const request = new Request("http://localhost/", {
          method: "POST",
          headers: { "content-type": contentType },
          body: raw,
        });
        value = [...(await request.formData())];
      }
      const entry = {
        method: req.method,
        url: req.url,
        contentType,
        value,
        authorization: req.headers.authorization ?? null,
      };
      seen.push(entry);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(entry));
    } catch (error) {
      res.statusCode = 400;
      res.end(String(error));
    }
  });
  await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
  let app = await createApp({ root, port: 0 });
  const clients = new Set();
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
    get app() {
      return app;
    },
    async restart() {
      await closeApp();
      app = await createApp({ root, port: 0 });
    },
  };
}
async function files(directory, prefix = "") {
  const output = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const key = path.join(prefix, entry.name),
      location = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(output, await files(location, key));
    else output[key] = (await readFile(location)).toString("base64");
  }
  return output;
}
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
const payloadSignature = (request) => ({
  bodyType: request.bodyType,
  body: request.body,
  form: request.form,
  schema: request.schema,
  contentType: request.headers.find(
    (row) => row.key.toLowerCase() === "content-type",
  )?.value,
  required: request.openapiOperation?.requestBody?.required,
  description: request.openapiOperation?.requestBody?.description,
});
function assertRun(run) {
  assert.equal(run.status, "passed", JSON.stringify(run));
  assert.equal(run.recordSaved, true);
  assert.equal(run.results.length, 4);
  const values = run.results.map((step) => {
    assert.equal(step.status, "passed");
    assert.equal(step.response.status, 200);
    return JSON.parse(step.response.body);
  });
  assert.deepEqual(
    values.map((entry) => entry.url),
    ["/v1/json", "/v1/text", "/v1/form", "/v1/multipart"],
  );
  for (const entry of values) {
    assert.equal(entry.method, "POST");
    assert.equal(entry.authorization, null);
  }
  assert.deepEqual(values[0].value, {
    person: "Ada + 中文",
    enabled: false,
    count: 0,
    literal: { $ref: "#/literal-data" },
  });
  assert.equal(values[0].contentType, "application/json");
  assert.equal(values[1].value, "hello Ada + 中文 & +");
  assert.equal(values[1].contentType, "text/plain; charset=utf-8");
  const entries = [
    ["person", "Ada + 中文"],
    ["enabled", "false"],
    ["count", "0"],
    ["empty", ""],
  ];
  assert.deepEqual(values[2].value, entries);
  assert.equal(values[2].contentType, "application/x-www-form-urlencoded");
  assert.deepEqual(values[3].value, entries);
  assert.match(values[3].contentType, /^multipart\/form-data; boundary=/);
}
const planInput = (project, name) => ({
  name,
  environmentId: project.environments[0].id,
  steps: project.requests
    .filter((request) => request.sourceOperationId !== "file")
    .map((request) => ({ request })),
});
async function cli(root, projectId, planId, output) {
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
      settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(Error("Swagger CLI deadline exceeded\n" + stderr));
    }, 10000);
    child.once("error", (error) => {
      finish(error);
    });
    child.once("close", (code) => {
      finish(null, { code, stdout, stderr });
    });
  });
}

test(
  "Swagger body migration survives owner persistence, frozen execution, OpenAPI export, CLI, backup and official SDK HTTP/stdio",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    let project = await f.call(
      "/api/projects",
      "POST",
      { name: "Swagger source" },
      201,
    );
    const source = document(f.host),
      beforeSource = structuredClone(source);
    project = await f.call(`/api/projects/${project.id}/import`, "POST", {
      document: source,
    });
    assert.deepEqual(source, beforeSource);
    assert.equal(f.seen.length, 0);
    assert.equal(project.requests.length, 5);
    assert.equal(
      project.requests.find((request) => request.sourceOperationId === "file")
        .form[0].requiresFile,
      true,
    );
    project.environments[0].variables.person = "Ada + 中文";
    project = await f.call(`/api/projects/${project.id}`, "PUT", project);
    const imported = structuredClone(project.requests);
    const exported = await f.call(
      `/api/projects/${project.id}/export?format=openapi`,
    );
    assert.equal(exported.openapi, "3.0.3");
    for (const item of Object.values(exported.paths))
      for (const op of Object.values(item)) {
        for (const key of ["consumes", "produces", "schemes"])
          assert.equal(Object.hasOwn(op, key), false);
        assert(
          op.parameters.every(
            (parameter) => !["body", "formData"].includes(parameter.in),
          ),
        );
        assert(op.requestBody);
      }
    const jsonBody = exported.paths["/v1/json"].post.requestBody;
    assert.equal(jsonBody.required, true);
    assert.equal(jsonBody.description, "JSON payload");
    assert.equal(jsonBody["x-source"], "kept");
    for (const route of ["form", "multipart", "file"])
      assert.equal(
        exported.paths["/v1/" + route].post.requestBody.required,
        true,
      );
    let roundtrip = await f.call(
      "/api/projects",
      "POST",
      { name: "OAS3 roundtrip" },
      201,
    );
    roundtrip = await f.call(`/api/projects/${roundtrip.id}/import`, "POST", {
      document: exported,
    });
    for (const request of roundtrip.requests)
      assert.deepEqual(
        payloadSignature(request),
        payloadSignature(
          imported.find(
            (entry) => entry.sourceOperationId === request.sourceOperationId,
          ),
        ),
      );
    roundtrip.environments[0].variables.person = "Ada + 中文";
    roundtrip = await f.call(`/api/projects/${roundtrip.id}`, "PUT", roundtrip);
    const plan = await f.call(
      `/api/projects/${project.id}/plans`,
      "POST",
      planInput(project, "Frozen Swagger payloads"),
    );
    const roundtripPlan = await f.call(
      `/api/projects/${roundtrip.id}/plans`,
      "POST",
      planInput(roundtrip, "OAS3 payloads"),
    );
    project = await f.call(`/api/projects/${project.id}`);
    const frozen = structuredClone(
      project.plans.find((item) => item.id === plan.id),
    );
    project.requests.find(
      (request) => request.sourceOperationId === "json",
    ).body = '{"live":"edited"}';
    project.requests.find(
      (request) => request.sourceOperationId === "form",
    ).form[0].value = "live edited";
    await f.call(`/api/projects/${project.id}`, "PUT", project);
    await f.restart();
    const persisted = await f.call(`/api/projects/${project.id}`);
    assert.deepEqual(
      persisted.plans.find((item) => item.id === plan.id),
      frozen,
    );
    assert.equal(
      persisted.requests.find((request) => request.sourceOperationId === "json")
        .body,
      '{"live":"edited"}',
    );
    assert.equal(f.seen.length, 0);
    const ownerRun = await f.call(`/api/projects/${project.id}/run`, "POST", {
      planId: plan.id,
    });
    assertRun(ownerRun);
    const roundtripRun = await f.call(
      `/api/projects/${roundtrip.id}/run`,
      "POST",
      { planId: roundtripPlan.id },
    );
    assertRun(roundtripRun);
    assert.equal(f.seen.length, 8);
    const output = path.join(f.root, "swagger-cli-evidence.json");
    const command = await cli(f.root, project.id, plan.id, output);
    assert.equal(command.code, 0, command.stderr + "\n" + command.stdout);
    const cliRun = JSON.parse(command.stdout);
    assertRun(cliRun);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), cliRun);
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
    assert.equal(f.seen.length, 12);
    await f.restart();
    assert.deepEqual(
      (await f.call(`/api/projects/${restored.id}`)).runs,
      backup.runs,
    );
    assert.equal(f.seen.length, 12);
    const untouched = await f.call(`/api/projects/${roundtrip.id}`);
    for (const transportKind of ["http", "stdio"]) {
      const targetId = transportKind === "http" ? project.id : restored.id;
      const client = new Client(
        { name: "swagger-body-fixture", version: "1" },
        { capabilities: {} },
      );
      f.clients.add(client);
      let transport;
      if (transportKind === "http") {
        const config = await f.call("/api/mcp/config", "POST", {
          enabled: true,
          projects: [targetId],
          write: true,
          execute: true,
          remember: false,
        });
        transport = new StreamableHTTPClientTransport(
          new URL(f.app.url + "/mcp"),
          {
            requestInit: {
              headers: { Authorization: "Bearer " + config.token },
            },
          },
        );
      } else
        transport = new StdioClientTransport({
          command: process.execPath,
          args: [mcpPath, "--project", targetId, "--write", "--execute"],
          env: { ...process.env, LOCAL_API_DATA: f.root },
          stderr: "pipe",
        });
      await client.connect(transport);
      const invoke = (name, args) =>
        client.callTool({
          name: "localapi_" + name,
          arguments: { projectId: targetId, ...args },
        });
      const before = f.seen.length;
      const denied = await invoke("run_plan", {
        projectId: roundtrip.id,
        planId: roundtripPlan.id,
      });
      assert.equal(denied.isError, true);
      assert.equal(denied.content[0].text, "项目未授权");
      assert.equal(f.seen.length, before);
      const sdkRun = decode(await invoke("run_plan", { planId: plan.id }));
      assertRun(sdkRun);
      assert.equal(f.seen.length, before + 4);
      const saved = (await f.call(`/api/projects/${targetId}`)).runs.find(
        (run) => run.id === sdkRun.id,
      );
      assert.equal(saved.source, "mcp");
      assert.deepEqual(
        decode(await invoke("get_execution_result", { runId: sdkRun.id })),
        saved,
      );
      const list = decode(
        await invoke("list_execution_runs", {
          scope: "flow",
          planId: plan.id,
          source: "mcp",
        }),
      );
      assert(list.some((entry) => entry.id === sdkRun.id));
      const rejectedRead = await invoke("get_execution_result", {
        projectId: roundtrip.id,
        runId: roundtripRun.id,
      });
      assert.equal(rejectedRead.isError, true);
      assert.equal(rejectedRead.content[0].text, "项目未授权");
      assert.equal(f.seen.length, before + 4);
      await client.close();
      f.clients.delete(client);
    }
    assert.equal(f.seen.length, 20);
    assert.deepEqual(await f.call(`/api/projects/${roundtrip.id}`), untouched);
    const savedBeforeRestart = await f.call(`/api/projects/${restored.id}`);
    await f.restart();
    const final = await f.call(`/api/projects/${restored.id}`);
    assert.deepEqual(final.runs, savedBeforeRestart.runs);
    assert.deepEqual(final.plans, backup.plans);
    assert.equal(f.seen.length, 20);
  },
);

test(
  "Swagger invalid mixed batches leave memory and disk unchanged; file placeholders never connect",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    let project = await f.call(
      "/api/projects",
      "POST",
      { name: "Atomic Swagger import" },
      201,
    );
    project = await f.call(`/api/projects/${project.id}/import`, "POST", {
      document: document(f.host),
    });
    const before = await f.call(`/api/projects/${project.id}`);
    const disk = await files(f.app.store.directory(project.id));
    const invalid = [
      operation([body({}), body({}, { name: "second" })]),
      operation([body({}), form("a", "string")]),
      operation([body({})], { consumes: [] }),
      operation([body({})], { schemes: ["https"] }),
      operation(
        [
          form("tags", "array", {
            items: { type: "string" },
            collectionFormat: "multi",
          }),
        ],
        { consumes: ["multipart/form-data"] },
      ),
      operation([body({ $ref: "#/definitions/Recursive" })]),
      operation([body({ $ref: "https://example.invalid/not-fetched.json" })]),
    ];
    for (const op of invalid) {
      const source = document(f.host);
      source.definitions.Recursive = {
        type: "object",
        properties: { child: { $ref: "#/definitions/Recursive" } },
      };
      source.paths["/bad"] = { post: op };
      const memory = structuredClone(before),
        input = structuredClone(source);
      assert.throws(() => importIntoProject(memory, source), /Swagger|外部/);
      assert.deepEqual(memory, before);
      assert.deepEqual(source, input);
      const failure = await f.call(
        `/api/projects/${project.id}/import`,
        "POST",
        { document: source },
        400,
      );
      assert.match(failure.error, /Swagger|外部/);
      assert.deepEqual(await f.call(`/api/projects/${project.id}`), before);
      assert.deepEqual(await files(f.app.store.directory(project.id)), disk);
      assert.equal(f.seen.length, 0);
    }
    const file = project.requests.find(
      (request) => request.sourceOperationId === "file",
    );
    const failed = await f.call(`/api/projects/${project.id}/execute`, "POST", {
      request: file,
    });
    assert.equal(failed.outcome, "failed");
    assert.match(failed.error, /重新选择导入的文件/);
    assert.equal(f.seen.length, 0);
    const current = await f.call(`/api/projects/${project.id}`);
    assert.equal(current.history.length, 1);
    assert.equal(current.history[0].status, "failed");
    assert.deepEqual(current.requests, before.requests);
    assert.equal(current.history[0].response, undefined);
  },
);
