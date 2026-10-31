import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { readFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import { Server } from "socket.io";
import { snapshotPlan, runPlan, restoreProject } from "../src/core.mjs";
import { projectScopes, persistScopeChanges } from "../src/variable-scopes.mjs";
import { ProjectCommitUncertain } from "../src/project-commit-outcome.mjs";
import { executeRequest, Store } from "../src/runtime.mjs";
import { executeGrpc } from "../src/grpc.mjs";
import { executeSocketIOFlow } from "../src/socketio-plan.mjs";
import { executeWireFlow } from "../src/wire-plan.mjs";
const fresh = "fresh-loopback-token";
const protoURL = new URL("./fixtures/grpc.proto", import.meta.url);
const proto = await readFile(protoURL, "utf8");
async function fixture(t, onIssue = () => false) {
  const seen = [],
    calls = { grpc: 0, socketio: 0, protocol: 0 },
    sockets = new Set();
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
  });
  const io = new Server(server);
  io.on("connection", (socket) => {
    socket.on("issue", (_request, ack) => {
      calls.socketio++;
      if (onIssue("socketio")) return;
      ack({ text: fresh, count: 7 });
    });
    socket.on("fail", () => {
      calls.socketio++;
    });
  });
  const tcp = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.on("data", () => {
      calls.protocol++;
      if (onIssue("protocol")) return;
      socket.end(fresh);
    });
  });
  const rpc = new grpc.Server();
  const pkg = grpc.loadPackageDefinition(
    loader.loadSync(fileURLToPath(protoURL), {
      longs: String,
      bytes: String,
      defaults: true,
    }),
  );
  rpc.addService(pkg.fixture.Echo.service, {
    Unary(_call, done) {
      calls.grpc++;
      if (onIssue("grpc")) return;
      done(null, { text: fresh, count: 7 });
    },
    Fail(_call, done) {
      calls.grpc++;
      done({ code: 7, details: "fixture denied" });
    },
  });
  const grpcPort = await new Promise((resolve, reject) =>
    rpc.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (e, port) => (e ? reject(e) : resolve(port)),
    ),
  );
  await Promise.all([
    new Promise((r) => server.listen(0, "127.0.0.1", r)),
    new Promise((r) => tcp.listen(0, "127.0.0.1", r)),
  ]);
  t.after(async () => {
    rpc.forceShutdown();
    for (const s of sockets) s.destroy();
    server.closeAllConnections();
    await Promise.all([
      new Promise((r) => io.close(r)),
      new Promise((r) => tcp.close(r)),
    ]);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const steps = {
    grpc: {
      type: "grpc",
      grpc: {
        definition: {
          target: `grpc://127.0.0.1:${grpcPort}`,
          proto,
          service: "fixture.Echo",
          method: "Unary",
        },
        messages: [{}],
      },
    },
    socketio: {
      type: "socketio",
      socketio: {
        definition: { url },
        timeoutMs: 1000,
        commands: [
          { type: "emit", event: "issue", args: [{}], ackTimeoutMs: 100 },
        ],
      },
    },
    protocol: {
      type: "protocol",
      protocol: {
        definition: { type: "tcp", url: "127.0.0.1", port: tcp.address().port },
        message: "issue",
        duration: 1000,
      },
    },
  };
  return {
    seen,
    calls,
    steps,
    http: {
      request: {
        url: url + "/use",
        headers: ["token", "envToken", "globalToken"].map((name) => ({
          key: "x-" + name.toLowerCase(),
          value: "{{" + name + "}}",
          enabled: true,
        })),
      },
    },
  };
}
const executors = {
  executeGrpc,
  executeSocketIO: executeSocketIOFlow,
  executeProtocol: executeWireFlow,
};
const valuePath = {
  grpc: "$[0].text",
  socketio: "$[0].args[0].text",
  protocol: "$.body",
};
const secondPath = {
  grpc: "$[0].count",
  socketio: "$[0].args[0].count",
  protocol: "$.size",
};
const scopes = (hidden = []) => ({
  globals: { globalToken: "old-global" },
  environment: { envToken: "old-env" },
  runtime: { token: "old-runtime" },
  hidden,
});
for (const family of ["grpc", "socketio", "protocol"])
  test(`${family} extraction batch cannot leak a partial token into later real HTTP`, async (t) => {
    const f = await fixture(t);
    for (const hidden of [[], ["token"]]) {
      const initial = scopes(hidden),
        untouched = structuredClone(initial);
      let commits = 0;
      const plan = snapshotPlan({
        steps: [
          {
            ...f.steps[family],
            extract: [
              { name: "token", path: valuePath[family], scope: "runtime" },
              {
                name: "envToken",
                path: valuePath[family],
                scope: "environment",
              },
              { name: "globalToken", path: valuePath[family], scope: "global" },
              { name: "missing", path: "$.missing", scope: "runtime" },
            ],
          },
          hidden.length
            ? {
                request: {
                  ...f.http.request,
                  headers: f.http.request.headers.filter(
                    (row) => row.key !== "x-token",
                  ),
                },
              }
            : f.http,
        ],
      });
      const run = await runPlan(plan, {}, executeRequest, {
        ...executors,
        variableScopes: initial,
        onScopeChanges: async () => {
          commits++;
        },
      });
      assert.equal(run.status, "failed");
      assert.equal(
        run.results.length,
        2,
        "ordinary protocol failure still continues",
      );
      assert.equal(run.results[1].status, "passed");
      assert.match(run.results[0].error, /无法提取/);
      const sent = f.seen.at(-1);
      assert.equal(sent["x-token"], hidden.length ? undefined : "old-runtime");
      assert.equal(sent["x-envtoken"], "old-env");
      assert.equal(sent["x-globaltoken"], "old-global");
      assert.deepEqual(run.results[0].extracted, {});
      if (hidden.length)
        assert.equal(Object.hasOwn(run.variables, "token"), false);
      assert.equal(commits, 0);
      assert.deepEqual(initial, untouched);
    }
    assert.equal(f.calls[family], 2);
    assert.equal(f.seen.length, 2);
  });

for (const family of ["grpc", "socketio", "protocol"])
  test(`${family} commits complete scopes once, preserving duplicate target order and hidden unmasking`, async (t) => {
    const f = await fixture(t);
    const initial = scopes(["token"]),
      untouched = structuredClone(initial);
    const batches = [];
    const last = family === "protocol" ? Buffer.byteLength(fresh) : 7;
    const run = await runPlan(
      snapshotPlan({
        steps: [
          {
            ...f.steps[family],
            extract: [
              { name: "token", path: valuePath[family], scope: "runtime" },
              { name: "token", path: secondPath[family], scope: "runtime" },
              {
                name: "envToken",
                path: valuePath[family],
                scope: "environment",
              },
              { name: "globalToken", path: valuePath[family], scope: "global" },
            ],
          },
          f.http,
        ],
      }),
      {},
      executeRequest,
      {
        ...executors,
        variableScopes: initial,
        onScopeChanges: async (changes) => {
          batches.push(structuredClone(changes));
        },
      },
    );
    assert.equal(run.status, "passed");
    assert.deepEqual(run.results[0].extracted, {
      token: last,
      envToken: fresh,
      globalToken: fresh,
    });
    assert.equal(batches.length, 1);
    assert.equal(batches[0].length, 2);
    assert.equal(f.seen[0]["x-token"], String(last));
    assert.equal(f.seen[0]["x-envtoken"], fresh);
    assert.equal(f.seen[0]["x-globaltoken"], fresh);
    assert.equal(f.calls[family], 1);
    assert.deepEqual(initial, untouched);
  });

for (const family of ["grpc", "socketio", "protocol"])
  test(`${family} failed persistence never publishes its candidate or trusts a forged unknown code`, async (t) => {
    const f = await fixture(t);
    for (const forged of [false, true]) {
      const initial = scopes(),
        untouched = structuredClone(initial);
      let commits = 0;
      const run = await runPlan(
        snapshotPlan({
          steps: [
            {
              ...f.steps[family],
              extract: [
                { name: "token", path: valuePath[family], scope: "runtime" },
                {
                  name: "envToken",
                  path: valuePath[family],
                  scope: "environment",
                },
                {
                  name: "globalToken",
                  path: valuePath[family],
                  scope: "global",
                },
              ],
            },
            f.http,
          ],
        }),
        {},
        executeRequest,
        {
          ...executors,
          variableScopes: initial,
          onScopeChanges: async () => {
            commits++;
            const error = Error("private failure should not appear in result");
            if (forged) error.code = "PROJECT_COMMIT_UNCERTAIN";
            throw error;
          },
        },
      );
      assert.equal(run.status, "failed");
      assert.equal(run.results[1].status, "passed");
      assert.deepEqual(run.results[0].extracted, {});
      assert.equal(run.results[0].scopeCommit, undefined);
      assert.match(run.results[0].error, /协议变量持久化失败/);
      assert.doesNotMatch(JSON.stringify(run), /private failure/);
      assert.equal(commits, 1);
      assert.equal(f.seen.at(-1)["x-token"], "old-runtime");
      assert.equal(f.seen.at(-1)["x-envtoken"], "old-env");
      assert.equal(f.seen.at(-1)["x-globaltoken"], "old-global");
      assert.deepEqual(initial, untouched);
    }
    assert.equal(f.calls[family], 2, "storage failures never replay transport");
  });

for (const family of ["grpc", "socketio", "protocol"])
  test(`${family} real journal uncertainty preserves local batch while recovery reflects actual committed storage`, async (t) => {
    const f = await fixture(t);
    const root = await mkdtemp(path.join(tmpdir(), "protocol-batch-journal-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = new Store(root),
      p = await store.create("owned"),
      other = await store.create("isolated");
    p.globalVariables = { globalToken: "old-global" };
    p.environments[0].variables = { envToken: "old-env" };
    await store.save(p);
    const otherBefore = await store.get(other.id);
    const directory = store.directory(p.id),
      history = path.join(directory, "history"),
      kept = path.join(directory, "history-kept");
    const originalSave = store.save,
      originalRead = store.readUnlocked;
    let failure,
      attempts = 0,
      obstructed = false;
    store.save = async function (project, options) {
      attempts++;
      this.readUnlocked = async function (id) {
        const result = await originalRead.call(this, id);
        this.readUnlocked = originalRead;
        await rename(history, kept);
        await writeFile(history, "private-obstacle");
        obstructed = true;
        return result;
      };
      try {
        return await originalSave.call(this, project, options);
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        this.readUnlocked = originalRead;
      }
    };
    const initial = {
      ...projectScopes(p, p.environments[0].id),
      runtime: { token: "old-runtime" },
    };
    const plan = snapshotPlan({
      steps: [
        {
          ...f.steps[family],
          extract: [
            { name: "token", path: valuePath[family], scope: "runtime" },
            { name: "envToken", path: valuePath[family], scope: "environment" },
            { name: "globalToken", path: valuePath[family], scope: "global" },
          ],
        },
        f.http,
      ],
    });
    const run = await runPlan(plan, {}, executeRequest, {
      ...executors,
      variableScopes: initial,
      onScopeChanges: async (changes) =>
        (await persistScopeChanges(store, p.id, p.environments[0].id, changes))
          .scopes,
    });
    assert.ok(failure instanceof ProjectCommitUncertain);
    assert.equal(attempts, 1);
    assert.equal(run.status, "failed");
    assert.equal(run.results[1].status, "passed");
    assert.deepEqual(run.results[0].extracted, {});
    assert.deepEqual(run.results[0].scopeCommit, {
      outcome: "unknown",
      retrySafe: false,
    });
    assert.doesNotMatch(
      JSON.stringify(run.results[0].scopeCommit),
      new RegExp(p.id),
    );
    assert.doesNotMatch(run.results[0].error, /private-obstacle|ENOTDIR/);
    assert.equal(f.seen[0]["x-token"], "old-runtime");
    assert.equal(f.seen[0]["x-envtoken"], "old-env");
    assert.equal(f.seen[0]["x-globaltoken"], "old-global");
    assert.equal(f.calls[family], 1);
    assert.ok(
      JSON.parse(
        await readFile(path.join(directory, ".transaction.json"), "utf8"),
      ),
    );
    store.save = originalSave;
    if (obstructed) {
      await rm(history);
      await rename(kept, history);
    }
    const recovered = await new Store(root).get(p.id);
    assert.equal(
      recovered.environments[0].variables.envToken,
      fresh,
      "unknown never promises disk rollback",
    );
    assert.equal(recovered.globalVariables.globalToken, fresh);
    assert.deepEqual(await new Store(root).get(other.id), otherBefore);
  });

for (const family of ["grpc", "socketio", "protocol"])
  test(`${family} frozen batch and saved results survive backup/restart without consulting edited live definition`, async (t) => {
    const f = await fixture(t);
    const root = await mkdtemp(path.join(tmpdir(), "protocol-batch-freeze-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = new Store(root),
      p = await store.create("frozen"),
      other = await store.create("untouched");
    p.globalVariables = { globalToken: "old-global" };
    p.environments[0].variables = { envToken: "old-env" };
    const source = {
      ...structuredClone(f.steps[family]),
      extract: [
        { name: "token", path: valuePath[family], scope: "runtime" },
        { name: "envToken", path: valuePath[family], scope: "environment" },
        { name: "globalToken", path: valuePath[family], scope: "global" },
      ],
    };
    p.plans = [
      snapshotPlan({ name: "frozen evidence", steps: [source, f.http] }),
    ];
    source.extract[0].path = "$.missing";
    source[family].definition = {};
    await store.save(p);
    const isolated = await store.get(other.id);
    const execute = async (project) => {
      const run = await runPlan(project.plans[0], {}, executeRequest, {
        ...executors,
        variableScopes: projectScopes(project, project.environments[0].id),
        onScopeChanges: async (changes) =>
          (
            await persistScopeChanges(
              store,
              project.id,
              project.environments[0].id,
              changes,
            )
          ).scopes,
      });
      assert.equal(run.status, "passed");
      assert.equal(f.seen.at(-1)["x-token"], fresh);
      await store.append(project.id, "runs", run);
      return run;
    };
    const first = await execute(await new Store(root).get(p.id));
    const backup = await new Store(root).get(p.id);
    assert.deepEqual(backup.runs[0].results[0].extracted, {
      token: fresh,
      envToken: fresh,
      globalToken: fresh,
    });
    const copy = restoreProject(JSON.stringify(backup));
    await store.save(copy);
    const restored = await new Store(root).get(copy.id);
    assert.deepEqual(restored.plans[0].steps[0], backup.plans[0].steps[0]);
    assert.equal(restored.runs[0].id, first.id);
    await execute(restored);
    assert.equal((await new Store(root).get(copy.id)).runs.length, 2);
    assert.equal((await new Store(root).get(p.id)).runs.length, 1);
    assert.deepEqual(await new Store(root).get(other.id), isolated);
    assert.equal(f.calls[family], 2);
  });

for (const family of ["grpc", "socketio", "protocol"])
  test(`${family} real cancellation retains raw outcome, diagnoses cancellation and never begins a scope commit`, async (t) => {
    const controller = new AbortController();
    const f = await fixture(t, (observed) => {
      assert.equal(observed, family);
      controller.abort();
      return true;
    });
    const initial = scopes(),
      untouched = structuredClone(initial);
    let commits = 0;
    const run = await runPlan(
      snapshotPlan({
        steps: [
          {
            ...f.steps[family],
            extract: [
              { name: "token", path: valuePath[family], scope: "runtime" },
              {
                name: "envToken",
                path: valuePath[family],
                scope: "environment",
              },
            ],
          },
          f.http,
        ],
      }),
      {},
      executeRequest,
      {
        ...executors,
        variableScopes: initial,
        signal: controller.signal,
        onScopeChanges: async () => {
          commits++;
        },
      },
    );
    assert.equal(run.results.length, 1);
    assert.equal(run.results[0].status, "failed");
    assert.match(run.results[0].error, /取消/);
    const raw = run.results[0][family + "Result"];
    assert.ok(raw);
    assert.equal(
      family === "grpc" ? raw.status.code : raw.status,
      family === "grpc" ? 1 : "cancelled",
    );
    assert.deepEqual(run.results[0].extracted, {});
    assert.equal(commits, 0);
    assert.equal(f.seen.length, 0);
    assert.equal(f.calls[family], 1);
    assert.deepEqual(initial, untouched);
  });

for (const family of ["grpc", "socketio", "protocol"])
  test(`${family} failed assertion or transport status cannot apply otherwise valid extraction`, async (t) => {
    const f = await fixture(t);
    for (const mode of ["assertion", "status"]) {
      const step = structuredClone(f.steps[family]);
      if (mode === "assertion")
        step.assertions = [{ target: "status", op: "eq", value: "impossible" }];
      else if (family === "grpc") step.grpc.definition.method = "Fail";
      else if (family === "socketio") step.socketio.commands[0].event = "fail";
      else step.protocol.definition.port = 0; // rejected before any transport effect
      step.extract = [
        { name: "token", path: valuePath[family], scope: "runtime" },
      ];
      // TCP connection failure uses a port closed by our own temporary listener.
      if (mode === "status" && family === "protocol") {
        const listener = net.createServer();
        await new Promise((r) => listener.listen(0, "127.0.0.1", r));
        step.protocol.definition.port = listener.address().port;
        await new Promise((r) => listener.close(r));
      }
      let commits = 0;
      const run = await runPlan(
        snapshotPlan({ steps: [step, f.http] }),
        {},
        executeRequest,
        {
          ...executors,
          variableScopes: scopes(),
          onScopeChanges: async () => {
            commits++;
          },
        },
      );
      assert.equal(run.results[0].status, "failed");
      assert.equal(run.results[1].status, "passed");
      assert.deepEqual(run.results[0].extracted, {});
      assert.equal(commits, 0);
      assert.equal(f.seen.at(-1)["x-token"], "old-runtime");
    }
  });

for (const family of ["grpc", "socketio", "protocol"])
  test(`${family} pre-journal filesystem failure retains prior committed state and hidden runtime`, async (t) => {
    const f = await fixture(t);
    const root = await mkdtemp(
      path.join(tmpdir(), "protocol-batch-prejournal-"),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = new Store(root),
      p = await store.create("pre-journal");
    p.globalVariables = { globalToken: "old-global" };
    p.environments[0].variables = { envToken: "old-env" };
    await store.save(p);
    const history = path.join(
      store.directory(p.id),
      "history",
      "requests.json",
    );
    const original = await readFile(history);
    await writeFile(history, "invalid owned JSON");
    const run = await runPlan(
      snapshotPlan({
        steps: [
          {
            ...f.steps[family],
            extract: [
              { name: "token", path: valuePath[family], scope: "runtime" },
              {
                name: "envToken",
                path: valuePath[family],
                scope: "environment",
              },
              { name: "globalToken", path: valuePath[family], scope: "global" },
            ],
          },
          {
            request: {
              ...f.http.request,
              headers: f.http.request.headers.filter(
                (row) => row.key !== "x-token",
              ),
            },
          },
        ],
      }),
      {},
      executeRequest,
      {
        ...executors,
        variableScopes: scopes(["token"]),
        onScopeChanges: async (changes) =>
          (
            await persistScopeChanges(
              store,
              p.id,
              p.environments[0].id,
              changes,
            )
          ).scopes,
      },
    );
    assert.equal(run.status, "failed");
    assert.equal(run.results[1].status, "passed");
    assert.deepEqual(run.results[0].extracted, {});
    assert.equal(run.results[0].scopeCommit, undefined);
    assert.match(run.results[0].error, /协议变量持久化失败/);
    assert.equal(Object.hasOwn(run.variables, "token"), false);
    assert.equal(f.seen[0]["x-envtoken"], "old-env");
    assert.equal(f.seen[0]["x-globaltoken"], "old-global");
    await assert.rejects(
      readFile(path.join(store.directory(p.id), ".transaction.json")),
      { code: "ENOENT" },
    );
    await writeFile(history, original);
    const recovered = await new Store(root).get(p.id);
    assert.equal(recovered.environments[0].variables.envToken, "old-env");
    assert.equal(recovered.globalVariables.globalToken, "old-global");
    assert.equal(f.calls[family], 1);
  });
