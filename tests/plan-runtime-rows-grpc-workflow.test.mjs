import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";

const repo = path.resolve(import.meta.dirname, "..");
const protoFile = new URL("./fixtures/grpc.proto", import.meta.url);
const proto = await readFile(protoFile, "utf8");
const methods = ["Unary", "Watch", "Collect", "Chat"];

async function fixture(t, items = [{ value: "a" }, { value: "b" }]) {
  const root = await mkdtemp(path.join(tmpdir(), "grpc-row-workflow-"));
  const received = [],
    consumed = [],
    httpCalls = [],
    clients = [];
  let beforeTerminal = async () => {};
  const server = new grpc.Server();
  const service = grpc.loadPackageDefinition(
    loader.loadSync(fileURLToPath(protoFile), {
      longs: String,
      bytes: String,
      defaults: true,
    }),
  ).fixture.Echo.service;
  const begin = (call, method) => {
    const row = {
      method,
      auth: call.metadata.get("authorization")[0],
      inputs: [],
      token: `reply-${method}-${received.length}`,
    };
    received.push(row);
    const headers = new grpc.Metadata();
    headers.set("x-private", String(row.auth));
    call.sendMetadata(headers);
    return row;
  };
  const reply = (row) => ({ text: row.token, count: row.inputs.length });
  server.addService(service, {
    async Unary(call, done) {
      const row = begin(call, "Unary");
      row.inputs.push(call.request);
      await beforeTerminal(row);
      done(null, reply(row));
    },
    async Watch(call) {
      const row = begin(call, "Watch");
      row.inputs.push(call.request);
      call.write(reply(row));
      if ((await beforeTerminal(row, call)) === false) return;
      call.write({ text: `${row.token}-tail` });
      call.end();
    },
    Collect(call, done) {
      const row = begin(call, "Collect");
      call.on("data", (message) => row.inputs.push(message));
      call.on("end", async () => {
        await beforeTerminal(row);
        done(null, reply(row));
      });
    },
    Chat(call) {
      const row = begin(call, "Chat");
      call.on("data", (message) => {
        row.inputs.push(message);
        call.write(reply(row));
      });
      call.on("end", async () => {
        if ((await beforeTerminal(row, call)) === false) return;
        call.end();
      });
    },
  });
  const port = await new Promise((resolve, reject) =>
    server.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (error, port) => (error ? reject(error) : resolve(port)),
    ),
  );
  const peer = http.createServer((req, res) => {
    httpCalls.push(req.url);
    if (req.url === "/consume") consumed.push(req.headers["x-token"]);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/produce" ? { items } : {}));
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
    app.server.closeAllConnections();
    peer.closeAllConnections();
    server.forceShutdown();
    await Promise.all(
      [app.server, peer].map((s) => new Promise((resolve) => s.close(resolve))),
    );
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("gRPC runtime rows workflow");
  project.settings ??= {};
  project.settings.grpcDefinitions = methods.map((method) => ({
    id: method,
    name: method,
    target: `grpc://127.0.0.1:${port}`,
    proto,
    service: "fixture.Echo",
    method,
    timeoutMs: 3000,
    requiredMetadata: ["authorization"],
  }));
  await app.store.save(project);
  const url = `http://127.0.0.1:${peer.address().port}`;
  const definition = (selected = methods) => ({
    name: "Frozen gRPC runtime rows",
    steps: [
      {
        id: "producer",
        request: {
          url: `${url}/produce`,
          extract: [{ name: "items", source: "json", path: "$.items" }],
        },
      },
      {
        id: "rows",
        type: "repeat",
        rowsFrom: { scope: "runtime", name: "items" },
        maxRows: 3,
        steps: [
          {
            id: "bind",
            request: {
              url: `${url}/bind`,
              beforeScript:
                "pm.environment.set('value', pm.iterationData.get('value'));",
            },
          },
          ...selected.flatMap((method) => [
            {
              id: method,
              type: "grpc",
              grpc: {
                definitionId: method,
                messages: [
                  { text: "{{value}}" },
                  ...(["Collect", "Chat"].includes(method)
                    ? [{ text: "second-{{value}}" }]
                    : []),
                ],
              },
              extract: [{ name: "token", path: "$[0].text" }],
            },
            {
              id: `consume-${method}`,
              request: {
                url: `${url}/consume`,
                headers: [{ key: "X-Token", value: "{{token}}" }],
              },
            },
          ]),
        ],
      },
    ],
  });
  const credentials = (selected = methods) =>
    Object.fromEntries(
      selected.map((method) => [
        method,
        {
          metadata: [{ key: "authorization", value: `private-row-${method}` }],
        },
      ]),
    );
  const post = async (route, body) => {
    const response = await fetch(`${app.url}/api/${route}`, {
      method: "POST",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, value: await response.json() };
  };
  return {
    root,
    app,
    project,
    received,
    consumed,
    httpCalls,
    definition,
    credentials,
    post,
    beforeTerminal(fn) {
      beforeTerminal = fn;
    },
    client() {
      const client = new Client({ name: "grpc-runtime-rows", version: "1" });
      clients.push(client);
      return client;
    },
  };
}

async function execute(f, mode, planId, grpcCredentials) {
  const projectId = f.project.id;
  if (mode === "owner") {
    const result = await f.post(`projects/${projectId}/run`, {
      planId,
      grpcCredentials,
    });
    assert.equal(result.status, 200, JSON.stringify(result.value));
    return result.value;
  }
  if (mode === "CLI")
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "scripts/run-plan.mjs",
          "--project",
          projectId,
          "--plan",
          planId,
          "--credentials-stdin",
        ],
        {
          cwd: repo,
          env: { ...process.env, LOCAL_API_DATA: f.root },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stdout = "",
        stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0)
          return reject(
            Error(`gRPC runtime rows CLI ${code}: ${stderr} ${stdout}`),
          );
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.end(JSON.stringify({ grpcCredentials }));
    });
  const client = f.client();
  let transport;
  if (mode === "SDK HTTP") {
    const config = await f.post("mcp/config", {
      enabled: true,
      projects: [projectId],
      write: true,
      execute: true,
      remember: false,
    });
    assert.equal(config.status, 200);
    transport = new StreamableHTTPClientTransport(new URL(f.app.url + "/mcp"), {
      requestInit: {
        headers: { Authorization: "Bearer " + config.value.token },
      },
    });
  } else
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        path.join(repo, "src/mcp.mjs"),
        "--project",
        projectId,
        "--write",
        "--execute",
      ],
      env: { ...process.env, LOCAL_API_DATA: f.root },
      stderr: "pipe",
    });
  await client.connect(transport, { timeout: 5000 });
  const result = await client.callTool(
    {
      name: "localapi_run_plan",
      arguments: { projectId, planId, grpcCredentials },
    },
    undefined,
    { timeout: 10000 },
  );
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

for (const mode of ["owner", "SDK HTTP", "SDK stdio", "CLI"])
  test(
    `${mode} gRPC runtime rows execute all four RPC styles with frozen references and stable leaf credentials`,
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t);
      const made = await f.post(
        `projects/${f.project.id}/plans`,
        f.definition(),
      );
      assert.equal(made.status, 200, JSON.stringify(made.value));
      const edited = await f.app.store.get(f.project.id);
      for (const definition of edited.settings.grpcDefinitions) {
        definition.target = "grpc://127.0.0.1:1";
        definition.proto = proto.replace(
          "string text = 1",
          "string renamed = 1",
        );
        definition.requiredMetadata = ["x-live"];
      }
      await f.app.store.save(edited);
      const run = await execute(f, mode, made.value.id, f.credentials());
      assert.equal(run.status, "passed", JSON.stringify(run));
      assert.equal(run.recordSaved, true);
      assert.equal(run.results.length, 19);
      assert.equal(run.conditionResults, undefined);
      assert.deepEqual(run.snapshot.steps[1].rowsFrom, {
        scope: "runtime",
        name: "items",
      });
      assert.equal(Object.hasOwn(run.snapshot.steps[1], "count"), false);
      const calls = run.results.filter((r) => r.type === "grpc");
      assert.deepEqual(
        calls.map((r) => r.grpcResult.messages.length),
        [1, 2, 1, 2, 1, 2, 1, 2],
      );
      assert.deepEqual(
        f.received.map((r) => r.inputs.map((m) => m.text)),
        ["a", "b"].flatMap((value) => [
          [value],
          [value],
          [value, `second-${value}`],
          [value, `second-${value}`],
        ]),
      );
      assert.deepEqual(
        f.consumed,
        f.received.map((r) => r.token),
      );
      assert.equal(run.variables.token, f.received.at(-1).token);
      for (const [index, result] of calls.entries()) {
        assert.equal(result.grpcResult.status.code, 0);
        assert.deepEqual(result.grpcResult.metadata, []);
        assert.deepEqual(result.grpcResult.trailers, []);
        assert.equal(result.grpc.definitionId, undefined);
        assert.equal(
          f.received[index].auth,
          `private-row-${methods[index % 4]}`,
        );
        assert.deepEqual(result.repeat, {
          groupId: "rows",
          childId: methods[index % 4],
          iteration: Math.floor(index / 4),
          occurrenceId: JSON.stringify([
            "rows",
            methods[index % 4],
            Math.floor(index / 4),
          ]),
        });
      }
      assert.equal(
        new Set(run.results.slice(1).map((r) => r.repeat.occurrenceId)).size,
        18,
      );
      const stored = await f.app.store.get(f.project.id);
      assert.equal(stored.runs.length, 1);
      assert.deepEqual(stored.runs[0].results, run.results);
      assert.deepEqual(stored.runs[0].snapshot, run.snapshot);
      assert.ok(!JSON.stringify(stored).includes("private-row-"));
      assert.ok(!JSON.stringify(run).includes("private-row-"));
    },
  );

test(
  "gRPC runtime rows require stable leaf credentials before producer even when rows are empty",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, []);
    const made = await f.post(
      `projects/${f.project.id}/plans`,
      f.definition(["Unary"]),
    );
    assert.equal(made.status, 200, JSON.stringify(made.value));
    for (const grpcCredentials of [
      {},
      { '["rows","Unary",0]': f.credentials(["Unary"]).Unary },
      {
        Unary: {
          ...f.credentials(["Unary"]).Unary,
          target: "grpc://127.0.0.1:1",
        },
      },
    ]) {
      const denied = await f.post(`projects/${f.project.id}/run`, {
        planId: made.value.id,
        grpcCredentials,
      });
      assert.equal(denied.status, 400);
      assert.deepEqual(f.httpCalls, []);
      assert.deepEqual(f.received, []);
    }
    const run = await execute(
      f,
      "owner",
      made.value.id,
      f.credentials(["Unary"]),
    );
    assert.equal(run.status, "passed");
    assert.equal(run.recordSaved, true);
    assert.deepEqual(
      run.results.map((r) => r.stepId),
      ["producer"],
    );
    assert.deepEqual(f.httpCalls, ["/produce"]);
    assert.deepEqual(f.received, []);
  },
);

for (const method of ["Watch", "Chat"])
  test(
    `gRPC runtime rows ${method} waits for terminal status before HTTP extraction consumer or next row`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t);
      const made = await f.post(
        `projects/${f.project.id}/plans`,
        f.definition([method]),
      );
      assert.equal(made.status, 200, JSON.stringify(made.value));
      let reached, release;
      const started = new Promise((resolve) => (reached = resolve));
      const terminal = new Promise((resolve) => (release = resolve));
      t.after(() => release());
      f.beforeTerminal(async () => {
        if (f.received.length === 1) {
          reached();
          await terminal;
        }
      });
      const executing = execute(
        f,
        "owner",
        made.value.id,
        f.credentials([method]),
      );
      await started;
      // The peer has already emitted a response message, but not terminal status.
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(f.received.length, 1);
      assert.deepEqual(f.consumed, []);
      assert.deepEqual(f.httpCalls, ["/produce", "/bind"]);
      release();
      const run = await executing;
      assert.equal(run.status, "passed");
      assert.deepEqual(
        f.consumed,
        f.received.map((r) => r.token),
      );
      assert.equal(f.received.length, 2);
      assert.deepEqual(
        run.results
          .filter((r) => r.type === "grpc")
          .map((r) => r.grpcResult.status.code),
        [0, 0],
      );
    },
  );

for (const mode of ["cancel", "non-OK", "deadline"])
  test(
    `gRPC runtime rows streamed ${mode} preserves partial evidence without extraction or later rows`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t);
      if (mode === "deadline") {
        const edited = await f.app.store.get(f.project.id);
        edited.settings.grpcDefinitions.find(
          (d) => d.id === "Watch",
        ).timeoutMs = 400;
        await f.app.store.save(edited);
      }
      const input = f.definition(["Watch"]);
      input.failurePolicy = "stop";
      const made = await f.post(`projects/${f.project.id}/plans`, input);
      assert.equal(made.status, 200, JSON.stringify(made.value));
      let reached, release;
      const started = new Promise((resolve) => (reached = resolve));
      const terminal = new Promise((resolve) => (release = resolve));
      t.after(() => release());
      f.beforeTerminal(async (_row, call) => {
        reached();
        await terminal;
        if (mode === "non-OK")
          call.emit("error", {
            code: grpc.status.PERMISSION_DENIED,
            details: "fixture stream refusal",
          });
        // Cancellation/deadline has already terminated the client. Do not send OK.
        return false;
      });
      const executing = f.post(`projects/${f.project.id}/run`, {
        planId: made.value.id,
        runId: `rows-stream-${mode}`,
        grpcCredentials: f.credentials(["Watch"]),
      });
      await started;
      // Let the emitted response reach the client before ending the stream.
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (mode === "cancel") {
        const cancelled = await f.post("cancel", { id: `rows-stream-${mode}` });
        assert.equal(cancelled.status, 200);
      } else if (mode === "non-OK") release();
      const response = await executing;
      release();
      assert.equal(response.status, 200);
      const run = response.value;
      assert.equal(
        run.status,
        mode === "cancel" ? "cancelled" : "failed",
        JSON.stringify(run),
      );
      if (mode !== "cancel") assert.equal(run.stopReason, "step-failure");
      assert.equal(run.recordSaved, true);
      assert.equal(f.received.length, 1);
      assert.deepEqual(f.consumed, []);
      assert.deepEqual(f.httpCalls, ["/produce", "/bind"]);
      assert.deepEqual(
        run.results.map((r) => r.stepId),
        ["producer", "bind", "Watch"],
      );
      const leaf = run.results.at(-1);
      assert.equal(
        leaf.grpcResult.status.code,
        mode === "cancel"
          ? grpc.status.CANCELLED
          : mode === "non-OK"
            ? grpc.status.PERMISSION_DENIED
            : grpc.status.DEADLINE_EXCEEDED,
      );
      assert.deepEqual(
        leaf.grpcResult.messages.map((m) => m.text),
        [f.received[0].token],
      );
      assert.deepEqual(leaf.extracted, {});
      assert.equal(Object.hasOwn(run.variables, "token"), false);
      assert.deepEqual(leaf.repeat, {
        groupId: "rows",
        childId: "Watch",
        iteration: 0,
        occurrenceId: JSON.stringify(["rows", "Watch", 0]),
      });
      assert.deepEqual(leaf.grpcResult.metadata, []);
      assert.deepEqual(leaf.grpcResult.trailers, []);
      const stored = await f.app.store.get(f.project.id);
      assert.deepEqual(stored.runs[0].results, run.results);
      assert.ok(!JSON.stringify(stored).includes("private-row-"));
    },
  );
