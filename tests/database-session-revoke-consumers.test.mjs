// Real loopback transports establish client cleanup, not server-side rollback.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { importIntoProject, snapshotPlan } from "../src/core.mjs";
import { parseRESP } from "../src/redis.mjs";
import { prepareCLIDatabaseGrants } from "../src/cli-database-grants.mjs";
import { nativeRedisFixture } from "./fixtures/apipost-redis.mjs";
import { observeToolCall } from "./helpers/mcp-cancellation-observation.mjs";
import { storedJSON } from "./helpers/stored-json.mjs";

async function until(predicate, message, budget = 1200) {
  const end = Date.now() + budget;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(10);
  }
  assert.fail(message);
}
function settle(promise) {
  const state = { done: false };
  state.promise = promise.then(
    (value) => {
      state.value = value;
      state.done = true;
    },
    (error) => {
      state.error = error;
      state.done = true;
    },
  );
  return state;
}
async function redisPeer(t) {
  const sockets = [],
    closed = new Set(),
    commands = [];
  let holding = true;
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    socket.once("close", () => closed.add(socket));
    let pending = Buffer.alloc(0);
    socket.on("data", (bytes) => {
      pending = Buffer.concat([pending, bytes]);
      for (;;) {
        const parsed = parseRESP(pending);
        if (!parsed) break;
        pending = pending.subarray(parsed.bytes);
        const args = parsed.value.map((value) => value.toString());
        commands.push({ socket, command: args[0] });
        if (args[0] === "AUTH" && holding) continue;
        socket.write(args[0] === "GET" ? "$11\r\nfresh-value\r\n" : "+OK\r\n");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    sockets,
    closed,
    commands,
    release() {
      holding = false;
      for (const socket of sockets)
        if (!socket.destroyed) socket.write("+OK\r\n");
    },
    config: {
      type: "redis",
      host: "127.0.0.1",
      port: server.address().port,
      database: "1",
      password: "FICTIONAL_REVOKE_SECRET",
    },
  };
}
const operation = (id) => ({
  type: "database",
  connectionId: id,
  sql: '["GET","fixture"]',
  parameters: [],
  name: "dbValue",
  path: "$.rows[0].value",
});
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};

function bounded(promise, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(message)), 5000);
    }),
  ]).finally(() => clearTimeout(timer));
}
async function bytes(directory) {
  const result = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const file = path.join(directory, entry.name);
    result[entry.name] = entry.isDirectory()
      ? await bytes(file)
      : (await readFile(file)).toString("base64");
  }
  return result;
}
const gate = (id, steps) => ({
  id,
  type: "if",
  condition: { op: "eq", left: { literal: true }, right: { literal: true } },
  steps,
});
const cases = [
  ...["revoke", "rotate", "disable-execute", "sdk-cancel"].flatMap((change) =>
    [undefined, "continue", "stop"].map((failurePolicy) => ({
      change,
      failurePolicy,
      native: false,
      missingFile: false,
    })),
  ),
  ...["revoke", "sdk-cancel"].flatMap((change) =>
    [undefined, "stop"].map((failurePolicy) => ({
      change,
      failurePolicy,
      native: true,
      missingFile: false,
    })),
  ),
  ...["revoke", "rotate"].map((change) => ({
    change,
    failurePolicy: "stop",
    native: false,
    missingFile: true,
  })),
];
for (const { change, failurePolicy, native, missingFile } of cases) {
  test(
    `official SDK IF/repeat ${native ? "native task" : "before operation"} ${change}, ${failurePolicy ?? "omitted continue"}, ${missingFile ? "missing-file save refusal" : "durable history"}`,
    { timeout: 20000 },
    async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), "mcp-db-revoke-root-"));
      const hits = [],
        attempts = [];
      const abort = new AbortController();
      const appendTerminal = Promise.withResolvers();
      let app, echo, client, observation, originalAppend, removed;
      let appendSettled = false,
        effects = 0;
      const closeApp = async () => {
        if (!app) return;
        const current = app;
        app = undefined;
        const closed = new Promise((resolve, reject) =>
          current.server.close((error) => (error ? reject(error) : resolve())),
        );
        current.server.closeIdleConnections();
        try {
          await bounded(closed, "owned app did not close");
        } catch (error) {
          current.server.closeAllConnections();
          throw error;
        }
      };
      // Register before Redis cleanup. App close synchronously cancels owned
      // executions; cleanup must not release a held read and start a tail.
      t.after(async () => {
        const failures = [];
        const capture = async (fn) => {
          try {
            await fn();
          } catch (error) {
            failures.push(error);
          }
        };
        const closing = closeApp().then(
          () => undefined,
          (error) => error,
        );
        abort.abort();
        if (client) await capture(() => client.close());
        if (observation) {
          await capture(() =>
            bounded(observation.completion, "SDK cleanup did not settle"),
          );
          // A rejected SDK promise does not join the actual server append.
          if (!appendSettled)
            await capture(() =>
              bounded(appendTerminal.promise, "server append did not settle"),
            );
        }
        const error = await closing;
        if (error) failures.push(error);
        if (echo) {
          echo.closeAllConnections();
          if (echo.listening)
            await capture(() => new Promise((resolve) => echo.close(resolve)));
        }
        if (!failures.length) await rm(root, { recursive: true, force: true });
        assert.deepEqual(failures, []);
      });
      const redis = await redisPeer(t);
      app = await createApp({ root, port: 0 });
      echo = http.createServer((req, res) => {
        hits.push(req.url);
        if (req.url === "/earlier") effects++;
        res.setHeader("content-type", "application/json");
        res.end('{"effect":"accepted-before-revocation"}');
      });
      await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${echo.address().port}`;
      const project = await app.store.create("revoked read"),
        other = await app.store.create("unrelated");
      const otherBefore = await app.store.get(other.id),
        otherBytes = await bytes(app.store.directory(other.id));
      let nativeRequest;
      if (native) {
        importIntoProject(project, nativeRedisFixture(origin + "/database"));
        nativeRequest = structuredClone(project.requests[0]);
        // Use a real imported DB task without unrelated fixture scripts.
        nativeRequest.nativeTasks.before =
          nativeRequest.nativeTasks.before.filter(
            (task) => task.type === "database",
          );
        nativeRequest.nativeTasks.after = [];
      }
      const owner = async (route, body, method = "POST") => {
        const response = await fetch(app.url + "/api/" + route, {
          method,
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(5000),
        });
        const value = await response.json();
        assert.equal(response.status, 200, JSON.stringify(value));
        return value;
      };
      const policy = {
        enabled: true,
        projects: [project.id, other.id],
        write: true,
        execute: true,
        remember: false,
      };
      const enabled = await owner("mcp/config", policy);
      client = new Client({ name: "revoke-consumer", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
          requestInit: {
            headers: { Authorization: "Bearer " + enabled.token },
          },
        }),
        { timeout: 5000 },
      );
      // The source catalog must be real persisted input for native admission.
      await app.store.save(project);
      const endpoint = `projects/${project.id}/mcp-database-connections`;
      const connection = await owner(endpoint, {
        ...redis.config,
        name: "read only",
        ...(native
          ? { bindingId: project.settings.apipostDatabases[0].id }
          : {}),
      });
      const leaf = (id, extra = {}) => ({
        id,
        request: { method: "GET", url: origin + "/" + id, ...extra },
      });
      const earlier = leaf("earlier", {
        id: "owned-api",
        extract: [
          {
            name: "acceptedEffect",
            source: "json",
            path: "$.effect",
            scope: "environment",
          },
        ],
      });
      project.requests.push(structuredClone(earlier.request));
      const database = native
        ? { id: "database", request: nativeRequest }
        : leaf("database", {
            before: [operation(connection.id)],
            afterScript: 'pm.environment.set("afterDb", "must-not-persist");',
          });
      project.plans = [
        snapshotPlan({
          id: "read-plan",
          ...(failurePolicy === undefined ? {} : { failurePolicy }),
          steps: [
            earlier,
            gate("outer", [
              {
                id: "repeat",
                type: "repeat",
                count: 2,
                steps: [database, leaf("inner-tail")],
              },
            ]),
            gate("later", [leaf("tail")]),
          ],
        }),
      ];
      await app.store.save(project);
      originalAppend = app.store.append;
      app.store.append = async function (id, field, record, ...rest) {
        const observed = id === project.id && field === "runs";
        if (observed) attempts.push(structuredClone(record));
        try {
          return await originalAppend.call(this, id, field, record, ...rest);
        } finally {
          if (observed) {
            appendSettled = true;
            appendTerminal.resolve();
          }
        }
      };
      observation = observeToolCall(
        client.callTool(
          {
            name: "localapi_run_plan",
            arguments: { projectId: project.id, planId: "read-plan" },
          },
          undefined,
          { signal: abort.signal, timeout: 15000 },
        ),
      );
      await until(
        () => redis.commands.length === 1,
        "Redis AUTH must reach the actual peer",
        5000,
      );
      observation.assertPending();
      assert.deepEqual(
        redis.commands.map((row) => row.command),
        ["AUTH"],
      );
      assert.deepEqual(hits, ["/earlier"]);
      assert.equal(effects, 1);
      const committed = await app.store.get(project.id);
      assert.equal(
        committed.environments[0].variables.acceptedEffect,
        "accepted-before-revocation",
      );
      assert.equal(committed.runs.length, 0);
      if (missingFile) {
        const file = path.join(
          app.store.directory(project.id),
          "apis",
          "key-" + Buffer.from("owned-api").toString("base64url") + ".json",
        );
        removed = { file, content: await readFile(file) };
        await rm(file);
        removed.damagedBytes = await bytes(app.store.directory(project.id));
      }
      if (change === "revoke")
        await owner(endpoint, { id: connection.id }, "DELETE");
      else if (change === "sdk-cancel") abort.abort();
      else
        await owner("mcp/config", {
          ...policy,
          ...(change === "rotate" ? { rotate: true } : { execute: false }),
        });
      const terminal = await bounded(
        observation.completion,
        "SDK execution did not settle",
      );
      const cancelled = change !== "revoke";
      let returned;
      if (cancelled) {
        assert.equal(terminal.kind, "rejected");
        assert.match(
          terminal.reason.message,
          change === "sdk-cancel"
            ? /abort|cancel/i
            : /MCP authorization changed/,
        );
        if (change !== "sdk-cancel") assert.equal(terminal.reason.code, -32000);
      } else {
        assert.equal(terminal.kind, "fulfilled", terminal.reason?.message);
        returned = decode(terminal.value);
        assert.equal(returned.recordSaved, !missingFile);
        assert.equal(returned.status, "failed");
      }
      await until(
        () => redis.closed.has(redis.sockets[0]),
        "revocation must close the actual owned Redis socket",
      );
      await bounded(
        appendTerminal.promise,
        "real server append did not settle",
      );
      let activity;
      await until(
        async () => {
          const state = await owner("mcp/config", undefined, "GET");
          activity = state.activities.find(
            (entry) =>
              entry.projectId === project.id &&
              entry.tool === "localapi_run_plan",
          );
          return activity && activity.status !== "running";
        },
        "server terminal activity was not published",
        5000,
      );
      assert.equal(activity.recordSaved, !missingFile);
      assert.equal(
        activity.status,
        missingFile ? "failed" : cancelled ? "cancelled" : "failed",
      );
      assert.equal(
        activity.executionStatus,
        cancelled ? "cancelled" : "failed",
      );
      if (missingFile) assert.match(activity.persistenceError, /保存失败/);
      assert.equal(attempts.length, 1);
      const run = attempts[0];
      assert.equal(run.status, cancelled ? "cancelled" : "failed");
      assert.equal(run.snapshot.failurePolicy, failurePolicy);
      assert.equal(
        Object.hasOwn(run.snapshot, "failurePolicy"),
        failurePolicy !== undefined,
      );
      const continues = !cancelled && failurePolicy !== "stop";
      const ids = continues
        ? [
            "earlier",
            "database",
            "inner-tail",
            "database",
            "inner-tail",
            "tail",
          ]
        : ["earlier", "database"];
      assert.deepEqual(
        run.results.map((row) => row.stepId),
        ids,
      );
      assert.deepEqual(
        hits,
        continues
          ? ["/earlier", "/inner-tail", "/inner-tail", "/tail"]
          : ["/earlier"],
      );
      assert.deepEqual(
        run.conditionResults.map((row) => [row.stepId, row.matched]),
        continues
          ? [
              ["outer", true],
              ["later", true],
            ]
          : [["outer", true]],
      );
      assert.equal(run.results[0].status, "passed");
      assert.equal(run.results[0].response.status, 200);
      assert.equal(
        JSON.parse(run.results[0].response.body).effect,
        "accepted-before-revocation",
      );
      const failures = run.results.filter((row) => row.stepId === "database");
      assert.equal(failures.length, continues ? 2 : 1);
      failures.forEach((row, index) => {
        assert.equal(row.status, "failed");
        assert.equal(row.response, undefined);
        assert.equal(row.repeat.iteration, index);
        if (!cancelled) assert.match(row.error, /权限.*撤销|未授权/);
        if (native) {
          assert.equal(row.databaseQueries.length, 1);
          assert.equal(
            row.databaseQueries[0].status,
            cancelled ? "interrupted" : "failed",
          );
        }
      });
      if (!cancelled && failurePolicy === "stop") {
        assert.equal(run.stopReason, "step-failure");
        assert.deepEqual(run.failureStop, {
          stepId: "database",
          repeat: run.results[1].repeat,
        });
      } else {
        assert.equal(run.stopReason, undefined);
        assert.equal(Object.hasOwn(run, "failureStop"), false);
      }
      if (returned) assert.deepEqual(returned.results, storedJSON(run.results));
      assert.equal(Object.hasOwn(run.variables, "dbValue"), false);
      assert.equal(Object.hasOwn(run.variables, "native_value"), false);
      redis.release();
      await delay(30);
      assert.deepEqual(
        redis.commands.map((row) => row.command),
        ["AUTH"],
      );
      if (missingFile) {
        assert.deepEqual(
          await bytes(app.store.directory(project.id)),
          removed.damagedBytes,
        );
        await assert.rejects(
          readFile(
            path.join(app.store.directory(project.id), ".transaction.json"),
          ),
          { code: "ENOENT" },
        );
        await assert.rejects(readFile(removed.file), { code: "ENOENT" });
        // Repair only this fixture's removed file, after actual append completion.
        await writeFile(removed.file, removed.content);
        assert.deepEqual(await app.store.get(project.id), committed);
      } else {
        const reopened = await new Store(root).get(project.id);
        assert.equal(reopened.runs.length, 1);
        assert.deepEqual(reopened.runs[0], storedJSON(run));
        assert.equal(reopened.environments[0].variables.afterDb, undefined);
        assert.equal(
          reopened.environments[0].variables.native_value,
          undefined,
        );
      }
      assert.equal(
        JSON.stringify({ run, activity, returned }).includes(
          redis.config.password,
        ),
        false,
      );
      assert.deepEqual(await app.store.get(other.id), otherBefore);
      assert.deepEqual(await bytes(app.store.directory(other.id)), otherBytes);
      const expected = await app.store.get(project.id);
      await client.close();
      client = undefined;
      app.store.append = originalAppend;
      await closeApp();
      app = await createApp({ root, port: 0 });
      assert.deepEqual(await new Store(root).get(project.id), expected);
      assert.deepEqual(await new Store(root).get(other.id), otherBefore);
      assert.equal(
        effects,
        1,
        "restart cannot undo or replay the completed effect",
      );
      assert.deepEqual(
        hits,
        continues
          ? ["/earlier", "/inner-tail", "/inner-tail", "/tail"]
          : ["/earlier"],
      );
      assert.deepEqual(
        redis.commands.map((row) => row.command),
        ["AUTH"],
      );
    },
  );
}

test(
  "CLI grant close cancels an actual held Redis transport and a fresh invocation remains usable",
  { timeout: 10000 },
  async (t) => {
    const redis = await redisPeer(t);
    const plan = { steps: [{ request: { before: [operation("fixture")] } }] };
    const grants = prepareCLIDatabaseGrants("cli-project", plan, {
      fixture: redis.config,
    });
    t.after(() => grants.close());
    const pending = settle(grants.query(operation("fixture")));
    await until(
      () => redis.commands.length === 1,
      "CLI grant must send real AUTH",
    );
    grants.close();
    await until(
      () => pending.done && redis.closed.has(redis.sockets[0]),
      "CLI grant close must interrupt the read, not wait for query timeout",
    );
    await pending.promise;
    assert.match(pending.error?.message ?? "", /撤销|关闭/);
    assert.equal(pending.value, undefined);
    await assert.rejects(grants.query(operation("fixture")), /关闭/);
    redis.release();
    await delay(20);
    assert.deepEqual(
      redis.commands.map((row) => row.command),
      ["AUTH"],
    );
    const fresh = prepareCLIDatabaseGrants("cli-project", plan, {
      fixture: redis.config,
    });
    t.after(() => fresh.close());
    const result = await fresh.query(operation("fixture"));
    assert.equal(result.rows[0].value, "fresh-value");
    assert.deepEqual(
      redis.commands.map((row) => row.command),
      ["AUTH", "AUTH", "SELECT", "GET"],
    );
    fresh.close();
    fresh.close();
  },
);

test(
  "CLI caller cancellation remains cancellation and does not revoke its saved invocation grant",
  { timeout: 10000 },
  async (t) => {
    const redis = await redisPeer(t);
    const plan = { steps: [{ request: { before: [operation("fixture")] } }] };
    const grants = prepareCLIDatabaseGrants("cli-project", plan, {
      fixture: redis.config,
    });
    t.after(() => grants.close());
    const controller = new AbortController();
    const pending = settle(
      grants.query(operation("fixture"), controller.signal),
    );
    await until(
      () => redis.commands.length === 1,
      "caller cancellation starts after actual AUTH",
    );
    controller.abort();
    await until(
      () => pending.done && redis.closed.has(redis.sockets[0]),
      "caller cancellation closes actual socket",
    );
    assert.match(pending.error?.message ?? "", /已取消/);
    assert.equal(pending.error?.code, "DATABASE_QUERY_CANCELLED");
    redis.release();
    const result = await grants.query(operation("fixture"));
    assert.equal(result.rows[0].value, "fresh-value");
  },
);
