import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store, executeRequest } from "../src/runtime.mjs";
import { runPlan } from "../src/core.mjs";
import { executeGrpc } from "../src/grpc.mjs";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const protoFile = new URL("./fixtures/grpc.proto", import.meta.url);
const proto = await readFile(protoFile, "utf8");
const cert = await readFile(
  new URL("./fixtures/localhost.crt", import.meta.url),
  "utf8",
);
const key = await readFile(
  new URL("./fixtures/localhost.key", import.meta.url),
  "utf8",
);
const decode = (r) => {
  assert.notEqual(r.isError, true, r.content?.[0]?.text);
  return JSON.parse(r.content[0].text);
};
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error("gRPC repeat fixture timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function fixture(t, secure = false) {
  const root = await mkdtemp(path.join(tmpdir(), "repeat-grpc-workflow-"));
  let app = await createApp({ root, port: 0 });
  const received = [],
    consumed = [],
    clients = [],
    active = new Set();
  let beforeHTTP = async () => {},
    stallSecond = false;
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
      token: `reply-${received.length + 1}`,
      auth: call.metadata.get("authorization")[0],
      inputs: [],
    };
    received.push(row);
    call.on("cancelled", () => active.delete(call));
    call.on("close", () => active.delete(call));
    const headers = new grpc.Metadata();
    headers.set("x-private", String(row.auth));
    call.sendMetadata(headers);
    return row;
  };
  const reply = (row) => ({ text: row.token, count: row.inputs.length });
  server.addService(service, {
    Unary(call, done) {
      const row = begin(call, "Unary");
      row.inputs.push(call.request);
      if (stallSecond && received.length === 2) {
        active.add(call);
        return;
      }
      done(null, reply(row));
    },
    Watch(call) {
      const row = begin(call, "Watch");
      row.inputs.push(call.request);
      call.write(reply(row));
      call.write({ text: `${row.token}-tail` });
      call.end();
    },
    Collect(call, done) {
      const row = begin(call, "Collect");
      call.on("data", (value) => row.inputs.push(value));
      call.on("end", () => done(null, reply(row)));
    },
    Chat(call) {
      const row = begin(call, "Chat");
      call.on("data", (value) => {
        row.inputs.push(value);
        call.write(reply(row));
      });
      call.on("end", () => call.end());
    },
    Fail(call, done) {
      begin(call, "Fail");
      done({ code: 7, details: "fixture refusal" });
    },
    Overflow(call) {
      begin(call, "Overflow");
      for (let i = 0; i < 101; i++) call.write({ text: `overflow-${i}` });
      call.end();
    },
  });
  const port = await new Promise((resolve, reject) =>
    server.bindAsync(
      "127.0.0.1:0",
      secure
        ? grpc.ServerCredentials.createSsl(
            Buffer.from(cert),
            [{ private_key: Buffer.from(key), cert_chain: Buffer.from(cert) }],
            true,
          )
        : grpc.ServerCredentials.createInsecure(),
      (error, port) => (error ? reject(error) : resolve(port)),
    ),
  );
  const peer = http.createServer(async (req, res) => {
    consumed.push({ token: req.headers["x-token"], url: req.url });
    await beforeHTTP();
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const closeApp = async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
    await closeApp();
    server.forceShutdown();
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("gRPC repeat");
  project.environments[0].variables = { token: "initial" };
  project.settings ??= {};
  project.settings.grpcDefinitions = [
    "Unary",
    "Watch",
    "Collect",
    "Chat",
    "Fail",
    "Overflow",
  ].map((method) => ({
    id: method,
    name: method,
    target: `${secure ? "grpcs" : "grpc"}://127.0.0.1:${port}`,
    proto,
    service: "fixture.Echo",
    method,
    timeoutMs: 3000,
    requiredMetadata: ["authorization"],
  }));
  await app.store.save(project);
  const definition = (methods = ["Unary"]) => ({
    name: "Frozen gRPC repeat",
    environmentId: project.environments[0].id,
    steps: [
      {
        type: "repeat",
        id: "group",
        count: 2,
        steps: methods.flatMap((method) => [
          {
            id: method,
            type: "grpc",
            grpc: {
              definitionId: method,
              messages: [
                { text: "{{token}}" },
                ...(["Collect", "Chat"].includes(method)
                  ? [{ text: "second" }]
                  : []),
              ],
            },
            extract: [{ name: "token", path: "$[0].text" }],
          },
          {
            id: `consume-${method}`,
            request: {
              method: "GET",
              url: `http://127.0.0.1:${peer.address().port}/consume`,
              headers: [{ key: "X-Token", value: "{{token}}" }],
            },
          },
        ]),
      },
    ],
  });
  const credentials = (methods = ["Unary"], token = "private-grpc-token-A") =>
    Object.fromEntries(
      methods.map((method) => [
        method,
        {
          metadata: [{ key: "authorization", value: token }],
          ...(secure ? { tls: { ca: cert, key, cert } } : {}),
        },
      ]),
    );
  const post = async (route, body) => {
    const response = await fetch(app.url + "/api/" + route, {
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
    project,
    received,
    consumed,
    active,
    definition,
    credentials,
    post,
    get app() {
      return app;
    },
    client() {
      const client = new Client({ name: "grpc-repeat", version: "1" });
      clients.push(client);
      return client;
    },
    async restart() {
      await closeApp();
      app = await createApp({ root, port: 0 });
    },
    stall() {
      stallSecond = true;
    },
    beforeHTTP(fn) {
      beforeHTTP = fn;
    },
  };
}
function checkRun(run, methods = ["Unary"]) {
  assert.equal(run.status, "passed");
  assert.equal(run.recordSaved, true);
  assert.equal(run.results.length, methods.length * 4);
  const expected = [0, 1].flatMap((iteration) =>
    methods.flatMap((method) =>
      [method, `consume-${method}`].map((childId) => ({
        groupId: "group",
        childId,
        iteration,
        occurrenceId: JSON.stringify(["group", childId, iteration]),
      })),
    ),
  );
  assert.deepEqual(
    run.results.map((row) => row.repeat),
    expected,
  );
  assert.equal(
    new Set(run.results.map((r) => r.repeat.occurrenceId)).size,
    run.results.length,
  );
  for (let iteration = 0; iteration < 2; iteration++)
    for (let j = 0; j < methods.length; j++) {
      const result = run.results[iteration * methods.length * 2 + j * 2];
      assert.equal(result.stepId, methods[j]);
      assert.equal(result.repeat.iteration, iteration);
      assert.equal(result.grpcResult.status.code, 0);
      assert.deepEqual(result.grpcResult.metadata, []);
      assert.deepEqual(result.grpcResult.trailers, []);
      assert.equal(result.grpc.definitionId, undefined);
    }
}
function cli(root, projectId, planId, grpcCredentials) {
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
        env: { ...process.env, LOCAL_API_DATA: root },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0)
        return reject(Error(`gRPC repeat CLI ${code}: ${stderr}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify({ grpcCredentials }));
  });
}
test(
  "gRPC repeat four call types consume independent responses through owner, SDK HTTP/stdio, CLI and restore",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      methods = ["Unary", "Watch", "Collect", "Chat"],
      p = f.project;
    const made = await f.post(`projects/${p.id}/plans`, f.definition(methods));
    assert.equal(made.status, 200);
    const plan = made.value,
      grpcCredentials = f.credentials(methods);
    const owner = await f.post(`projects/${p.id}/run`, {
      planId: plan.id,
      grpcCredentials,
    });
    assert.equal(owner.status, 200);
    checkRun(owner.value, methods);
    for (let i = 0; i < 8; i++)
      assert.equal(f.consumed[i].token, f.received[i].token);
    assert.deepEqual(
      owner.value.results
        .filter((r) => r.type === "grpc")
        .map((r) => r.grpcResult.messages.length),
      [1, 2, 1, 2, 1, 2, 1, 2],
    );
    const live = await f.app.store.get(p.id);
    for (const d of live.settings.grpcDefinitions) {
      d.target = "grpc://127.0.0.1:1";
      d.proto = proto.replace("string text = 1", "string renamed = 1");
      d.requiredMetadata = ["x-live"];
    }
    await f.app.store.save(live);
    const config = await f.post("mcp/config", {
      enabled: true,
      projects: [p.id],
      write: true,
      execute: true,
      remember: false,
    });
    assert.equal(config.status, 200);
    const sdk = f.client();
    await sdk.connect(
      new StreamableHTTPClientTransport(new URL(f.app.url + "/mcp"), {
        requestInit: {
          headers: { Authorization: "Bearer " + config.value.token },
        },
      }),
    );
    const sdkRun = decode(
      await sdk.callTool({
        name: "localapi_run_plan",
        arguments: { projectId: p.id, planId: plan.id, grpcCredentials },
      }),
    );
    checkRun(sdkRun, methods);
    assert.equal(sdkRun.planHash, owner.value.planHash);
    const deleted = await f.app.store.get(p.id);
    deleted.settings.grpcDefinitions = [];
    await f.app.store.save(deleted);
    const exported = await fetch(`${f.app.url}/api/projects/${p.id}/export`, {
      headers: { "x-local-token": f.app.token },
    });
    assert.equal(exported.status, 200);
    const backup = await exported.json();
    assert.ok(!JSON.stringify(backup).includes("private-grpc-token-A"));
    const restored = await f.post("restore", { document: backup });
    assert.equal(restored.status, 201);
    assert.deepEqual(restored.value.plans[0].steps, plan.steps);
    await sdk.close();
    await f.restart();
    const denied = await f.post(`projects/${restored.value.id}/run`, {
      planId: plan.id,
    });
    assert.equal(denied.status, 400);
    assert.equal(f.received.length, 16);
    const restarted = await f.post(`projects/${restored.value.id}/run`, {
      planId: plan.id,
      grpcCredentials,
    });
    checkRun(restarted.value, methods);
    assert.equal(restarted.value.planHash, owner.value.planHash);
    const stdio = f.client();
    await stdio.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          path.join(repo, "src/mcp.mjs"),
          "--project",
          restored.value.id,
          "--write",
          "--execute",
        ],
        env: { ...process.env, LOCAL_API_DATA: f.root },
        stderr: "pipe",
      }),
    );
    const stdioRun = decode(
      await stdio.callTool({
        name: "localapi_run_plan",
        arguments: {
          projectId: restored.value.id,
          planId: plan.id,
          grpcCredentials,
        },
      }),
    );
    checkRun(stdioRun, methods);
    assert.equal(stdioRun.planHash, owner.value.planHash);
    await stdio.close();
    const cliRun = await cli(
      f.root,
      restored.value.id,
      plan.id,
      grpcCredentials,
    );
    checkRun(cliRun, methods);
    assert.equal(cliRun.planHash, owner.value.planHash);
    assert.equal(f.received.length, 40);
    assert.equal(f.consumed.length, 40);
    for (let i = 0; i < 40; i++)
      assert.equal(f.consumed[i].token, f.received[i].token);
    const disk = await new Store(f.root).get(restored.value.id);
    assert.ok(!JSON.stringify(disk).includes("private-grpc-token-A"));
  },
);
test(
  "nested gRPC required metadata is checked before an earlier HTTP step; concurrent credentials never persist",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      input = f.definition();
    input.steps.unshift({
      id: "sentinel",
      request: structuredClone(input.steps[0].steps[1].request),
    });
    input.steps[1] = {
      type: "repeat",
      id: "outer-preflight",
      count: 1,
      steps: [input.steps[1]],
    };
    const made = await f.post(`projects/${f.project.id}/plans`, input);
    assert.equal(made.status, 200);
    for (const grpcCredentials of [
      {},
      { '["group","Unary",0]': f.credentials().Unary },
      {
        Unary: {
          metadata: [{ key: "authorization", value: "x" }],
          target: "grpc://127.0.0.1:1",
        },
      },
    ]) {
      const denied = await f.post(`projects/${f.project.id}/run`, {
        planId: made.value.id,
        grpcCredentials,
      });
      assert.equal(denied.status, 400);
      assert.equal(f.received.length, 0);
      assert.equal(f.consumed.length, 0);
    }
    const clean = await f.post(
      `projects/${f.project.id}/plans`,
      f.definition(),
    );
    const tokens = ["private-grpc-B", "private-grpc-C"];
    const runs = await Promise.all(
      tokens.map((token) =>
        f.post(`projects/${f.project.id}/run`, {
          planId: clean.value.id,
          grpcCredentials: f.credentials(["Unary"], token),
        }),
      ),
    );
    for (const r of runs) checkRun(r.value);
    for (const token of tokens)
      assert.equal(f.received.filter((r) => r.auth === token).length, 2);
    for (const [index, r] of runs.entries()) {
      const replies = r.value.results
        .filter((x) => x.type === "grpc")
        .map((x) => x.grpcResult.messages[0].text);
      const auth = f.received
        .filter((x) => replies.includes(x.token))
        .map((x) => x.auth);
      assert.equal(replies.length, 2);
      assert.deepEqual(auth, [tokens[index], tokens[index]]);
    }
    const disk = JSON.stringify(await new Store(f.root).get(f.project.id));
    for (const token of tokens) assert.ok(!disk.includes(token));
  },
);
test(
  "gRPC repeat CA and mutual TLS remain mandatory and temporary",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, true),
      made = await f.post(`projects/${f.project.id}/plans`, f.definition());
    assert.equal(made.status, 200);
    const valid = await f.post(`projects/${f.project.id}/run`, {
      planId: made.value.id,
      grpcCredentials: f.credentials(),
    });
    checkRun(valid.value);
    for (const tls of [{ key, cert }, { ca: cert }]) {
      const credentials = f.credentials();
      credentials.Unary.tls = tls;
      const response = await f.post(`projects/${f.project.id}/run`, {
        planId: made.value.id,
        grpcCredentials: credentials,
      });
      assert.equal(response.value.status, "failed");
      assert.equal(
        response.value.results.filter((r) => r.type === "grpc").length,
        2,
      );
      assert.ok(
        response.value.results
          .filter((r) => r.type === "grpc")
          .every((r) => r.grpcResult.status.code !== 0),
      );
    }
    const credentials = f.credentials();
    credentials.Unary.tls.rejectUnauthorized = false;
    const rejected = await f.post(`projects/${f.project.id}/run`, {
      planId: made.value.id,
      grpcCredentials: credentials,
    });
    assert.equal(rejected.status, 400);
    assert.equal(f.received.length, 2);
    const disk = JSON.stringify(await new Store(f.root).get(f.project.id));
    assert.ok(!disk.includes("PRIVATE KEY"));
    assert.ok(!disk.includes("BEGIN CERTIFICATE"));
    assert.ok(!disk.includes("private-grpc-token-A"));
  },
);
test(
  "gRPC repeat second call cancellation or external deadline prevents later HTTP and occurrences",
  { timeout: 15000 },
  async (t) => {
    for (const mode of ["owner-cancel", "deadline"])
      await t.test(mode, async (t) => {
        const f = await fixture(t);
        f.stall();
        const made = await f.post(
          `projects/${f.project.id}/plans`,
          f.definition(),
        );
        assert.equal(made.status, 200);
        const controller = new AbortController();
        const executing =
          mode === "owner-cancel"
            ? f.post(`projects/${f.project.id}/run`, {
                planId: made.value.id,
                runId: "grpc-repeat-cancel",
                grpcCredentials: f.credentials(),
              })
            : runPlan(made.value, { token: "initial" }, executeRequest, {
                executeGrpc,
                grpcCredentials: f.credentials(),
                signal: controller.signal,
              });
        await until(() => f.received.length === 2);
        if (mode === "owner-cancel")
          assert.equal(
            (await f.post("cancel", { id: "grpc-repeat-cancel" })).status,
            200,
          );
        else {
          const deadline = AbortSignal.timeout(100);
          deadline.addEventListener(
            "abort",
            () => controller.abort(deadline.reason),
            { once: true },
          );
        }
        const response = await executing,
          run = mode === "owner-cancel" ? response.value : response;
        assert.equal(run.status, "cancelled");
        assert.equal(run.results.length, 3);
        assert.equal(f.received.length, 2);
        assert.equal(f.consumed.length, 1);
        assert.equal(run.variables.token, f.received[0].token);
        assert.equal(run.results[2].grpcResult.status.code, 1);
        await until(() => f.active.size === 0);
      });
  },
);
test(
  "gRPC repeat nonzero statuses and bounded response overflow never masquerade as successful extraction",
  { timeout: 15000 },
  async (t) => {
    for (const [method, status] of [
      ["Fail", 7],
      ["Overflow", 8],
    ])
      await t.test(method, async (t) => {
        const f = await fixture(t),
          made = await f.post(
            `projects/${f.project.id}/plans`,
            f.definition([method]),
          );
        assert.equal(made.status, 200);
        const result = await f.post(`projects/${f.project.id}/run`, {
          planId: made.value.id,
          grpcCredentials: f.credentials([method]),
        });
        assert.equal(result.value.status, "failed");
        const results = result.value.results.filter((r) => r.type === "grpc");
        assert.equal(results.length, 2);
        for (const r of results) {
          assert.equal(r.grpcResult.status.code, status);
          assert.equal(r.status, "failed");
          assert.ok(r.grpcResult.messages.length <= 100);
          assert.deepEqual(r.extracted, {});
        }
        assert.equal(result.value.variables.token, "initial");
        assert.deepEqual(
          f.consumed.map((r) => r.token),
          ["initial", "initial"],
        );
      });
  },
);
test(
  "completed gRPC repeat is not replayed after genuine journal uncertainty or generic append failure",
  { timeout: 15000 },
  async (t) => {
    for (const mode of ["generic", "unknown"])
      await t.test(mode, async (t) => {
        const f = await fixture(t),
          p = f.project,
          made = await f.post(`projects/${p.id}/plans`, f.definition());
        assert.equal(made.status, 200);
        const directory = f.app.store.directory(p.id),
          history = path.join(directory, "history"),
          kept = path.join(directory, "owned-history-backup"),
          journal = path.join(directory, ".transaction.json"),
          file = path.join(history, "requests.json");
        const original = await readFile(file, "utf8"),
          save = f.app.store.save,
          read = f.app.store.readUnlocked;
        let attempted = 0;
        t.after(() => {
          f.app.store.save = save;
          f.app.store.readUnlocked = read;
        });
        if (mode === "generic")
          f.beforeHTTP(async () => {
            if (f.consumed.length === 2)
              await writeFile(file, '{"owned-broken":');
          });
        else
          f.app.store.save = async function (project, options) {
            if (project.id !== p.id || !options?.activity)
              return save.call(this, project, options);
            attempted++;
            this.readUnlocked = async function (id) {
              const state = await read.call(this, id);
              this.readUnlocked = read;
              await rename(history, kept);
              await writeFile(history, "private-obstacle-marker");
              return state;
            };
            try {
              return await save.call(this, project, options);
            } finally {
              this.readUnlocked = read;
            }
          };
        const response = await f.post(`projects/${p.id}/run`, {
            planId: made.value.id,
            grpcCredentials: f.credentials(),
          }),
          run = response.value;
        assert.equal(response.status, 200);
        assert.equal(run.status, "passed");
        assert.equal(run.results.length, 4);
        assert.equal(run.recordSaved, false);
        assert.equal(run.recordId, null);
        assert.equal(run.attemptedRecordId, run.id);
        assert.equal(run.persistenceOutcome.retry_safe, false);
        assert.equal(
          run.persistenceOutcome.code,
          mode === "generic"
            ? "RECORD_SAVE_FAILED"
            : "PROJECT_COMMIT_UNCERTAIN",
        );
        f.app.store.save = save;
        f.app.store.readUnlocked = read;
        if (mode === "generic") {
          await assert.rejects(readFile(journal), { code: "ENOENT" });
          await writeFile(file, original);
        } else {
          assert.equal(attempted, 1);
          assert.equal(run.persistenceOutcome.commit_outcome, "unknown");
          assert.ok((await readFile(journal, "utf8")).length > 0);
          await rm(history);
          await rename(kept, history);
        }
        const recovered = await new Store(f.root).get(p.id);
        assert.equal(
          recovered.runs.some((r) => r.id === run.id),
          mode === "unknown",
        );
        if (mode === "unknown")
          assert.deepEqual(
            recovered.runs
              .find((r) => r.id === run.id)
              .results.map((r) => r.repeat),
            run.results.map((r) => r.repeat),
          );
        assert.equal(f.received.length, 2);
        assert.equal(f.consumed.length, 2);
      });
  },
);
test(
  "gRPC repeat freezes virtual proto bundles and descriptor schemas, not live definitions",
  { timeout: 15000 },
  async (t) => {
    for (const kind of ["bundle", "descriptor"])
      await t.test(kind, async (t) => {
        const f = await fixture(t),
          live = await f.app.store.get(f.project.id);
        const definition = live.settings.grpcDefinitions[0];
        if (kind === "bundle") {
          definition.proto =
            'syntax="proto3"; package fixture; import "payload.proto"; service Echo { rpc Unary(Payload) returns(Payload); }';
          definition.files = {
            "payload.proto":
              'syntax="proto3"; package fixture; message Payload { string text=1; int32 count=4; }',
          };
          definition.protoName = "entry.proto";
        } else {
          delete definition.proto;
          definition.schema = {
            nested: {
              fixture: {
                nested: {
                  Payload: {
                    fields: {
                      text: { type: "string", id: 1 },
                      count: { type: "int32", id: 4 },
                    },
                  },
                  Echo: {
                    methods: {
                      Unary: {
                        requestType: "Payload",
                        responseType: "Payload",
                      },
                    },
                  },
                },
              },
            },
          };
        }
        await f.app.store.save(live);
        const made = await f.post(`projects/${live.id}/plans`, f.definition());
        assert.equal(made.status, 200);
        const frozen = structuredClone(
          made.value.steps[0].steps[0].grpc.definition,
        );
        const changed = await f.app.store.get(live.id);
        changed.settings.grpcDefinitions = [];
        await f.app.store.save(changed);
        const response = await f.post(`projects/${live.id}/run`, {
          planId: made.value.id,
          grpcCredentials: f.credentials(),
        });
        checkRun(response.value);
        assert.deepEqual(
          response.value.snapshot.steps[0].steps[0].grpc.definition,
          frozen,
        );
        assert.deepEqual(
          f.consumed.map((row) => row.token),
          f.received.map((row) => row.token),
        );
        const disk = await new Store(f.root).get(live.id);
        assert.deepEqual(
          disk.plans[0].steps[0].steps[0].grpc.definition,
          frozen,
        );
        const exported = await fetch(
          `${f.app.url}/api/projects/${live.id}/export`,
          { headers: { "x-local-token": f.app.token } },
        );
        assert.equal(exported.status, 200);
        const restored = await f.post("restore", {
          document: await exported.json(),
        });
        assert.equal(restored.status, 201);
        assert.deepEqual(
          restored.value.plans[0].steps[0].steps[0].grpc.definition,
          frozen,
        );
        await f.restart();
        const missing = await f.post(`projects/${restored.value.id}/run`, {
          planId: made.value.id,
        });
        assert.equal(missing.status, 400);
        assert.equal(f.received.length, 2);
        const resumed = await f.post(`projects/${restored.value.id}/run`, {
          planId: made.value.id,
          grpcCredentials: f.credentials(),
        });
        assert.equal(resumed.status, 200);
        checkRun(resumed.value);
        assert.equal(resumed.value.planHash, response.value.planHash);
        assert.deepEqual(
          resumed.value.snapshot.steps[0].steps[0].grpc.definition,
          frozen,
        );
        assert.equal(f.received.length, 4);
        assert.deepEqual(
          f.consumed.map((row) => row.token),
          f.received.map((row) => row.token),
        );
      });
  },
);
test(
  "gRPC repeat native deadline and atomic failed extraction retain prior variables",
  { timeout: 15000 },
  async (t) => {
    for (const mode of ["native-deadline", "atomic-extraction"])
      await t.test(mode, async (t) => {
        const f = await fixture(t),
          input = f.definition();
        if (mode === "native-deadline") {
          f.stall();
          const live = await f.app.store.get(f.project.id);
          live.settings.grpcDefinitions[0].timeoutMs = 200;
          await f.app.store.save(live);
        } else
          input.steps[0].steps[0].extract.push({
            name: "absent",
            path: "$[0].doesNotExist",
          });
        const made = await f.post(`projects/${f.project.id}/plans`, input);
        assert.equal(made.status, 200);
        const response = await f.post(`projects/${f.project.id}/run`, {
          planId: made.value.id,
          grpcCredentials: f.credentials(),
        });
        assert.equal(response.value.status, "failed");
        assert.equal(response.value.results.length, 4);
        assert.equal(f.received.length, 2);
        if (mode === "native-deadline") {
          assert.equal(response.value.results[2].grpcResult.status.code, 4);
          assert.equal(response.value.variables.token, f.received[0].token);
          assert.deepEqual(
            f.consumed.map((row) => row.token),
            [f.received[0].token, f.received[0].token],
          );
          await until(() => f.active.size === 0);
        } else {
          assert.equal(response.value.variables.token, "initial");
          assert.equal(response.value.variables.absent, undefined);
          for (const r of response.value.results.filter(
            (r) => r.type === "grpc",
          ))
            assert.deepEqual(r.extracted, {});
          assert.deepEqual(
            f.consumed.map((row) => row.token),
            ["initial", "initial"],
          );
        }
      });
  },
);
test(
  "gRPC repeat rejects bounded message and temporary metadata excess before transport",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      tooMany = f.definition(["Collect"]);
    tooMany.steps[0].steps[0].grpc.messages = Array.from(
      { length: 101 },
      () => ({ text: "x" }),
    );
    const invalid = await f.post(`projects/${f.project.id}/plans`, tooMany);
    assert.equal(invalid.status, 400);
    const made = await f.post(`projects/${f.project.id}/plans`, f.definition());
    assert.equal(made.status, 200);
    for (const metadata of [
      Array.from({ length: 101 }, () => ({ key: "authorization", value: "x" })),
      [{ key: "authorization", value: "x".repeat(8193) }],
    ]) {
      const denied = await f.post(`projects/${f.project.id}/run`, {
        planId: made.value.id,
        grpcCredentials: { Unary: { metadata } },
      });
      assert.equal(denied.status, 400);
    }
    assert.equal(f.received.length, 0);
    assert.equal(f.consumed.length, 0);
  },
);

test(
  "two-by-two nested gRPC repeats retain ordered path identities and independent calls",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      input = f.definition();
    input.steps = [
      { type: "repeat", id: "outer", count: 2, steps: input.steps },
    ];
    const made = await f.post(`projects/${f.project.id}/plans`, input);
    assert.equal(made.status, 200);
    const response = await f.post(`projects/${f.project.id}/run`, {
      planId: made.value.id,
      grpcCredentials: f.credentials(),
    });
    assert.equal(response.status, 200);
    const run = response.value;
    assert.equal(run.status, "passed");
    assert.equal(run.recordSaved, true);
    assert.equal(run.results.length, 8);
    assert.equal(f.received.length, 4);
    assert.equal(f.consumed.length, 4);
    assert.equal(
      new Set(run.results.map((r) => r.repeat.occurrenceId)).size,
      8,
    );
    for (let i = 0; i < 4; i++) {
      assert.deepEqual(run.results[i * 2].repeat.path, [
        { groupId: "outer", iteration: Math.floor(i / 2) },
        { groupId: "group", iteration: i % 2 },
      ]);
      assert.equal(run.results[i * 2].grpcResult.status.code, 0);
    }
  },
);
