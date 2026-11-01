// CI-only root composition: real HTTP collections, native gRPC, official SDK and CLI.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store, executeRequest } from "../src/runtime.mjs";
import { runPlan } from "../src/core.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
const before = [
  "pm.test('no preceding collection',()=>{pm.expect(apt.getVar('collectionOnly')).to.equal(undefined);pm.expect(pm.variables.get('collectionOnly')).to.equal(undefined);pm.expect(typeof pm.collectionVariables?.set).to.equal('undefined');});",
  "pm.environment.set('preCount',pm.environment.get('preCount')+1);",
  "pm.variables.set('message',pm.environment.get('fromHttp')+'|'+pm.environment.get('preCount'));",
  "apt.setVar('preRuntime','confirmed-'+pm.environment.get('preCount'));console.log('grpc-pre');",
].join("\n");
const after = [
  "pm.test('native response and no collection',()=>{pm.expect(grpc.result.status.code).to.equal(0);pm.expect(apt.getVar('collectionOnly')).to.equal(undefined);pm.expect(pm.variables.get('collectionOnly')).to.equal(undefined);pm.expect(pm.response).to.equal(undefined);});",
  "const token=grpc.result.messages[0].text;apt.setVar('runtimeToken',token);pm.environment.set('postToken',token);pm.globals.set('globalToken',token);console.log('grpc-post');",
].join("\n");

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "grpc-scripts-root-")),
    calls = [],
    seen = [],
    clients = [];
  let app, peer, rpc;
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
    rpc?.forceShutdown();
    if (app?.server.listening) {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
    }
    if (peer?.listening) {
      peer.closeAllConnections();
      await new Promise((resolve) => peer.close(resolve));
    }
    await rm(root, { recursive: true, force: true });
  });
  peer = http.createServer((req, res) => {
    const url = new URL(req.url, "http://fixture");
    const value = {
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
    };
    seen.push(value);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(value));
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${peer.address().port}`,
    protoFile = new URL("./fixtures/grpc.proto", import.meta.url),
    proto = await readFile(protoFile, "utf8");
  rpc = new grpc.Server();
  const service = grpc.loadPackageDefinition(
    loader.loadSync(fileURLToPath(protoFile), {
      longs: String,
      bytes: String,
      defaults: true,
    }),
  ).fixture.Echo.service;
  rpc.addService(service, {
    Unary(call, done) {
      const row = {
        input: call.request,
        auth: call.metadata.get("authorization")[0],
        token: "reply-" + (calls.length + 1),
      };
      calls.push(row);
      const headers = new grpc.Metadata();
      headers.set("x-private", String(row.auth));
      call.sendMetadata(headers);
      done(null, { text: row.token, count: calls.length });
    },
  });
  const port = await new Promise((resolve, reject) =>
    rpc.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (error, value) => (error ? reject(error) : resolve(value)),
    ),
  );
  app = await createApp({ root, port: 0 });
  const owner = async (route, method = "GET", body, status = 200) => {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  };
  const created = await owner(
    "/api/projects",
    "POST",
    { name: "Nested gRPC collection composition" },
    201,
  );
  for (const tag of ["A", "B"])
    await owner(`/api/projects/${created.id}/import`, "POST", {
      postmanVariableMode: "collection",
      document: {
        info: { name: tag, _postman_id: "same-upstream-id" },
        variable: [
          { key: "collectionOnly", value: tag },
          { key: "counter", value: 0, type: "number" },
        ],
        item: [
          {
            name: tag,
            request: { method: "GET", url: { raw: base + "/" + tag } },
          },
        ],
      },
    });
  const project = await app.store.get(created.id);
  project.environments[0].variables = {
    fromHttp: "seed",
    preCount: 0,
    postToken: "seed",
  };
  project.globalVariables = { globalToken: "seed" };
  project.settings.grpcDefinitions = [
    {
      id: "saved-rpc",
      name: "Frozen RPC",
      target: `grpc://127.0.0.1:${port}`,
      proto,
      service: "fixture.Echo",
      method: "Unary",
      timeoutMs: 3000,
      requiredMetadata: ["authorization"],
    },
  ];
  await app.store.save(project);
  const credentials = {
    rpc: {
      metadata: [
        { key: "authorization", value: "private-root-grpc-credential" },
      ],
    },
  };
  return {
    root,
    project,
    base,
    calls,
    seen,
    credentials,
    owner,
    get app() {
      return app;
    },
    async sdk(projectId, mode) {
      const client = new Client({ name: "grpc-root-" + mode, version: "1" });
      clients.push(client);
      let transport;
      if (mode === "http") {
        const config = await owner("/api/mcp/config", "POST", {
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
      } else
        transport = new StdioClientTransport({
          command: process.execPath,
          args: [
            path.join(repository, "src/mcp.mjs"),
            "--project",
            projectId,
            "--write",
            "--execute",
          ],
          env: { ...process.env, LOCAL_API_DATA: root },
          stderr: "pipe",
        });
      await client.connect(transport);
      return client;
    },
    async restart() {
      await Promise.all(
        clients.map((client) => client.close().catch(() => {})),
      );
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
      app = await createApp({ root, port: 0 });
    },
  };
}

function definition(f, { broken = false } = {}) {
  const [a, b] = f.project.requests;
  const common =
    "pm.collectionVariables.set('counter',pm.collectionVariables.get('counter')+1);";
  const consumer = (request, suffix) => ({
    ...request,
    url:
      f.base +
      "/" +
      suffix +
      "?scope={{collectionOnly}}&counter={{counter}}&env={{postToken}}&global={{globalToken}}&runtime={{runtimeToken}}&extracted={{extractedToken}}&pre={{preRuntime}}",
    beforeScript: common,
  });
  return {
    name: "Nested A RPC B A",
    environmentId: f.project.environments[0].id,
    statusPolicy: "strict200",
    steps: [
      {
        id: "outer",
        type: "repeat",
        count: 2,
        steps: [
          {
            id: "inner",
            type: "repeat",
            count: 2,
            steps: [
              {
                id: "a-start",
                request: {
                  ...a,
                  url:
                    f.base +
                    "/start?scope={{collectionOnly}}&counter={{counter}}",
                  beforeScript:
                    common +
                    "pm.environment.set('fromHttp','http-'+pm.collectionVariables.get('counter'));",
                },
              },
              {
                id: "rpc",
                type: "grpc",
                grpc: {
                  definitionId: "saved-rpc",
                  messages: [{ text: "{{message}}" }],
                },
                grpcScripts: { version: 1, before, after },
                assertions: [{ target: "status", op: "eq", value: 0 }],
                extract: [
                  { name: "extractedToken", path: "$[0].text" },
                  ...(broken ? [{ name: "missing", path: "$.absent" }] : []),
                ],
              },
              { id: "b-consume", request: consumer(b, "B") },
              { id: "a-consume", request: consumer(a, "A") },
            ],
          },
        ],
      },
    ],
  };
}

async function cli(f, projectId, planId) {
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
      cwd: repository,
      env: { ...process.env, LOCAL_API_DATA: f.root },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify({ grpcCredentials: f.credentials }));
  try {
    assert.equal(await closed, 0, stderr);
    return JSON.parse(stdout);
  } finally {
    clearTimeout(timer);
  }
}

function checkRun(f, run, ordinal, plan) {
  assert.equal(run.status, "passed", JSON.stringify(run.results));
  assert.equal(run.recordSaved, true);
  assert.equal(run.results.length, 16);
  assert.deepEqual(run.snapshot.steps, plan.steps);
  assert.equal(
    new Set(run.results.map((row) => row.repeat.occurrenceId)).size,
    16,
  );
  for (let cycle = 0; cycle < 4; cycle++) {
    const offset = ordinal * 4 + cycle,
      rows = run.results.slice(cycle * 4, cycle * 4 + 4),
      token = "reply-" + (offset + 1),
      firstCounter = ordinal * 8 + cycle * 2 + 1;
    assert.deepEqual(
      rows.map((row) => row.stepId),
      ["a-start", "rpc", "b-consume", "a-consume"],
    );
    for (const row of rows) {
      const p = [
        { groupId: "outer", iteration: Math.floor(cycle / 2) },
        { groupId: "inner", iteration: cycle % 2 },
      ];
      assert.deepEqual(row.repeat.path, p);
      assert.equal(
        row.repeat.occurrenceId,
        JSON.stringify([
          p.map(({ groupId, iteration }) => [groupId, iteration]),
          row.stepId,
        ]),
      );
    }
    assert.equal(
      f.calls[offset].input.text,
      `http-${firstCounter}|${offset + 1}`,
    );
    assert.equal(f.calls[offset].auth, "private-root-grpc-credential");
    assert.equal(rows[1].grpcResult.status.code, 0);
    assert.equal(rows[1].grpcResult.messages[0].text, token);
    assert.deepEqual(rows[1].grpcResult.metadata, []);
    assert.deepEqual(rows[1].grpcResult.trailers, []);
    assert.equal(rows[1].response, undefined);
    assert.equal(rows[1].extracted.extractedToken, token);
    assert(rows[1].assertions.some((a) => a.phase === "before"));
    assert(rows[1].assertions.some((a) => a.phase === "after"));
    for (const [row, scope, counter] of [
      [rows[2], "B", offset + 1],
      [rows[3], "A", firstCounter + 1],
    ]) {
      assert.deepEqual(JSON.parse(row.response.body).query, {
        scope,
        counter: String(counter),
        env: token,
        global: token,
        runtime: token,
        extracted: token,
        pre: "confirmed-" + (offset + 1),
      });
    }
  }
  assert(!JSON.stringify(run).includes("private-root-grpc-credential"));
}

test(
  "nested A gRPC B A scopes survive frozen definitions, SDK transports, CLI and backup restart without replay",
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t),
      p = f.project,
      plan = await f.owner(
        `/api/projects/${p.id}/plans`,
        "POST",
        definition(f),
      );
    const first = await f.owner(`/api/projects/${p.id}/run`, "POST", {
      planId: plan.id,
      grpcCredentials: f.credentials,
    });
    checkRun(f, first, 0, plan);
    const edited = await f.app.store.get(p.id);
    edited.settings.grpcDefinitions[0].target = "grpc://127.0.0.1:1";
    edited.settings.grpcDefinitions[0].proto =
      edited.settings.grpcDefinitions[0].proto.replace(
        "string text = 1",
        "string changed = 1",
      );
    edited.settings.grpcDefinitions[0].requiredMetadata = ["x-live-only"];
    edited.requests[0].url = "http://127.0.0.1:1/rebound";
    edited.requests[0].postmanCollectionId =
      edited.requests[1].postmanCollectionId;
    await f.app.store.save(edited);
    const sdk = await f.sdk(p.id, "http");
    const second = decode(
      await sdk.callTool({
        name: "localapi_execute_flow",
        arguments: {
          projectId: p.id,
          planId: plan.id,
          grpcCredentials: f.credentials,
        },
      }),
    );
    checkRun(f, second, 1, plan);
    assert.equal(second.planHash, first.planHash);
    const detail = decode(
      await sdk.callTool({
        name: "localapi_get_execution_result",
        arguments: { projectId: p.id, runId: second.id },
      }),
    );
    assert.deepEqual(detail.results, second.results);
    assert.equal(f.calls.length, 8);
    await sdk.close();
    const removed = await f.app.store.get(p.id);
    removed.settings.grpcDefinitions = [];
    await f.app.store.save(removed);
    const backup = await f.owner(`/api/projects/${p.id}/export`),
      restored = await f.owner(
        "/api/restore",
        "POST",
        { document: backup },
        201,
      );
    assert.deepEqual(restored.plans, backup.plans);
    assert.deepEqual(restored.runs, backup.runs);
    assert(!JSON.stringify(backup).includes("private-root-grpc-credential"));
    await f.restart();
    const recovered = await f.owner(`/api/projects/${restored.id}`);
    assert.deepEqual(recovered.plans, backup.plans);
    assert.deepEqual(recovered.runs, backup.runs);
    assert.equal(f.calls.length, 8);
    assert.equal(f.seen.length, 24);
    const stdio = await f.sdk(restored.id, "stdio");
    const third = decode(
      await stdio.callTool({
        name: "localapi_run_plan",
        arguments: {
          projectId: restored.id,
          planId: plan.id,
          grpcCredentials: f.credentials,
        },
      }),
    );
    checkRun(f, third, 2, plan);
    assert.equal(third.planHash, first.planHash);
    await stdio.close();
    const fourth = await cli(f, restored.id, plan.id);
    checkRun(f, fourth, 3, plan);
    assert.equal(fourth.planHash, first.planHash);
    assert.equal(f.calls.length, 16);
    assert.equal(f.seen.length, 48);
    const disk = await new Store(f.root).get(restored.id);
    assert.equal(disk.environments[0].variables.preCount, 16);
    assert.equal(disk.postmanCollections.items[0].variables.counter, 32);
    assert.equal(disk.postmanCollections.items[1].variables.counter, 16);
    assert(!JSON.stringify(disk).includes("private-root-grpc-credential"));
    const untouched = await f.owner(`/api/projects/${p.id}/export`);
    assert.deepEqual(untouched, backup);
  },
);

test(
  "nested script preflight rejects disabled malformed descendants before any earlier HTTP effect",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      valid = definition(f);
    const frozen = await f.owner(
      `/api/projects/${f.project.id}/plans`,
      "POST",
      valid,
    );
    for (const kind of ["version", "non-grpc", "group"]) {
      const bad = structuredClone(frozen),
        group = bad.steps[0];
      group.enabled = false;
      const leaves = group.steps[0].steps;
      if (kind === "version") leaves[1].grpcScripts.version = 2;
      else if (kind === "non-grpc") leaves[0].grpcScripts = { version: 1 };
      else group.grpcScripts = { version: 1 };
      bad.steps.unshift({
        id: "must-not-run",
        request: { url: f.base + "/must-not-run" },
      });
      await assert.rejects(
        runPlan(bad, {}, executeRequest),
        /gRPC|grpcScripts|未知/,
      );
    }
    assert.equal(f.calls.length, 0);
    assert.equal(f.seen.length, 0);
  },
);

test(
  "nested collection consumers see confirmed PRE but never rejected gRPC POST or partial extraction candidates",
  { timeout: 60000 },
  async (t) => {
    for (const failure of ["missing-extraction", "post-test"])
      await t.test(failure, async (t) => {
        const f = await fixture(t),
          project = await f.app.store.get(f.project.id);
        Object.assign(project.environments[0].variables, {
          runtimeToken: "old-runtime",
          extractedToken: "old-extracted",
        });
        await f.app.store.save(project);
        const input = definition(f, {
          broken: failure === "missing-extraction",
        });
        if (failure === "post-test")
          input.steps[0].steps[0].steps[1].grpcScripts.after +=
            "\npm.test('reject',()=>{throw Error('post rejected');});";
        const plan = await f.owner(
            `/api/projects/${project.id}/plans`,
            "POST",
            input,
          ),
          run = await f.owner(`/api/projects/${project.id}/run`, "POST", {
            planId: plan.id,
            grpcCredentials: f.credentials,
          });
        assert.equal(run.status, "failed");
        assert.equal(run.recordSaved, true);
        assert.equal(
          run.results.length,
          16,
          "ordinary failure preserves existing continue-to-next-leaf behavior",
        );
        for (let cycle = 0; cycle < 4; cycle++) {
          const rows = run.results.slice(cycle * 4, cycle * 4 + 4),
            rpc = rows[1];
          assert.equal(rpc.status, "failed");
          assert.equal(rpc.grpcResult.status.code, 0);
          assert.equal(rpc.grpcResult.messages[0].text, "reply-" + (cycle + 1));
          assert.deepEqual(rpc.extracted, {});
          assert(rpc.assertions.some((item) => item.phase === "after"));
          for (const row of [rows[2], rows[3]]) {
            const value = JSON.parse(row.response.body).query;
            assert.equal(row.status, "passed", JSON.stringify(row));
            assert.equal(value.env, "seed");
            assert.equal(value.global, "seed");
            assert.equal(value.runtime, "old-runtime");
            assert.equal(value.extracted, "old-extracted");
            assert.equal(value.pre, "confirmed-" + (cycle + 1));
          }
        }
        const saved = await new Store(f.root).get(project.id);
        assert.equal(saved.environments[0].variables.preCount, 4);
        assert.equal(saved.environments[0].variables.postToken, "seed");
        assert.equal(saved.globalVariables.globalToken, "seed");
        assert.deepEqual(
          saved.postmanCollections.items.map((item) => item.variables.counter),
          [8, 4],
        );
        assert.equal(run.variables.preRuntime, "confirmed-4");
        assert.equal(run.variables.runtimeToken, "old-runtime");
        assert.equal(f.calls.length, 4);
        assert.equal(f.seen.length, 12);
      });
  },
);
