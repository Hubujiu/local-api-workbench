// Real loopback transports establish client cleanup, not server-side rollback.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { snapshotPlan } from "../src/core.mjs";
import { parseRESP } from "../src/redis.mjs";
import { prepareCLIDatabaseGrants } from "../src/cli-database-grants.mjs";

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

for (const change of ["revoke", "rotate", "disable-execute"]) {
  test(
    `official SDK HTTP ${change} closes held Redis AUTH and saves failed history without applying a late database result`,
    { timeout: 12000 },
    async (t) => {
      const redis = await redisPeer(t);
      const root = await mkdtemp(
        path.join(tmpdir(), "mcp-db-revoke-consumer-"),
      );
      const app = await createApp({ root, port: 0 }),
        client = new Client({ name: "revoke-consumer", version: "1" });
      const hits = [];
      const echo = http.createServer((req, res) => {
        hits.push(req.url);
        res.end("{}");
      });
      await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
      t.after(async () => {
        await client.close().catch(() => {});
        app.server.closeAllConnections();
        echo.closeAllConnections();
        await Promise.all(
          [app.server, echo].map(
            (server) => new Promise((resolve) => server.close(resolve)),
          ),
        );
        await rm(root, { recursive: true, force: true });
      });
      const project = await app.store.create("revoked read"),
        other = await app.store.create("unrelated");
      const otherBefore = await app.store.get(other.id);
      const owner = async (route, body, method = "POST") => {
        const response = await fetch(app.url + "/api/" + route, {
          method,
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(3000),
        });
        assert.equal(response.ok, true, await response.clone().text());
        return response.json();
      };
      const policy = {
        enabled: true,
        projects: [project.id],
        write: true,
        execute: true,
        remember: false,
      };
      const enabled = await owner("mcp/config", policy);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
          requestInit: {
            headers: { Authorization: "Bearer " + enabled.token },
          },
        }),
      );
      const endpoint = `projects/${project.id}/mcp-database-connections`;
      const connection = await owner(endpoint, {
        ...redis.config,
        name: "read only",
      });
      const leaf = (id, extra = {}) => ({
        id,
        request: {
          method: "GET",
          url: `http://127.0.0.1:${echo.address().port}/${id}`,
          ...extra,
        },
      });
      project.plans = [
        snapshotPlan({
          id: "read-plan",
          steps: [
            leaf("earlier"),
            leaf("database", {
              before: [operation(connection.id)],
              afterScript: 'pm.environment.set("afterDb", "must-not-persist");',
            }),
            leaf("tail"),
          ],
        }),
      ];
      await app.store.save(project);
      const running = settle(
        client.callTool(
          {
            name: "localapi_run_plan",
            arguments: { projectId: project.id, planId: "read-plan" },
          },
          undefined,
          { timeout: 7000 },
        ),
      );
      await until(
        () => redis.commands.length === 1,
        "Redis AUTH must reach the actual peer",
        4000,
      );
      assert.deepEqual(
        redis.commands.map((row) => row.command),
        ["AUTH"],
      );
      assert.deepEqual(hits, ["/earlier"]);
      if (change === "revoke")
        await owner(endpoint, { id: connection.id }, "DELETE");
      else
        await owner("mcp/config", {
          ...policy,
          ...(change === "rotate" ? { rotate: true } : { execute: false }),
        });
      await until(
        () => redis.closed.has(redis.sockets[0]),
        "grant removal must close the read socket before its 3s query timeout",
      );
      await running.promise;
      assert.equal(running.error, undefined, running.error?.message);
      const run = decode(running.value);
      assert.equal(run.status, "failed");
      assert.notEqual(run.status, "cancelled");
      assert.equal(run.recordSaved, true, JSON.stringify(run.persistenceError));
      assert.deepEqual(
        run.results.map((row) => row.stepId),
        ["earlier", "database", "tail"],
      );
      assert.equal(run.results[1].status, "failed");
      assert.match(run.results[1].error, /权限.*撤销|未授权/);
      assert.equal(run.results[1].response, undefined);
      assert.equal(Object.hasOwn(run.variables, "dbValue"), false);
      // The base contract continues ordinary failed leaves: do not invent fail-fast.
      assert.deepEqual(hits, ["/earlier", "/tail"]);
      redis.release();
      await delay(30);
      assert.deepEqual(
        redis.commands.map((row) => row.command),
        ["AUTH"],
      );
      const reopened = await new Store(root).get(project.id);
      const saved = reopened.runs.find((row) => row.id === run.id);
      assert.deepEqual(saved.results, run.results);
      assert.equal(saved.status, "failed");
      assert.equal(reopened.environments[0].variables.afterDb, undefined);
      assert.equal(
        JSON.stringify({ run, reopened }).includes(redis.config.password),
        false,
      );
      assert.deepEqual(await app.store.get(other.id), otherBefore);
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
