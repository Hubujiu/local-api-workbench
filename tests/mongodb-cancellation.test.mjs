import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSessions } from "../src/database-sessions.mjs";
import { queryMongo } from "../src/mongodb.mjs";

// Real Mongo driver sockets connect to a nonresponding endpoint; not a MongoDB
// SQL/data fixture. Observe peer closure instead of mocking Worker.terminate.
test(
  "Mongo cancellation stops its worker sockets without cancelling another project",
  { timeout: 12000 },
  async (t) => {
    const sockets = [],
      closed = new Set();
    const endpoint = net.createServer((socket) => {
      sockets.push(socket);
      socket.on("data", () => {});
      socket.on("error", () => {});
      socket.on("close", () => closed.add(socket));
    });
    await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
    const sessions = new DatabaseSessions();
    t.after(async () => {
      sessions.close();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => endpoint.close(resolve));
    });
    const waitFor = async (predicate) => {
      const deadline = Date.now() + 2000;
      while (!predicate() && Date.now() < deadline) await delay(10);
      assert(predicate(), "fixture observation did not arrive within budget");
    };
    const config = {
      type: "mongodb",
      host: "127.0.0.1",
      port: endpoint.address().port,
      database: "fixture",
      name: "cancel fixture",
    };
    const first = sessions.register("first", config);
    const second = sessions.register("second", config);
    const operation = (id) => ({
      connectionId: id,
      sql: JSON.stringify({ collection: "items", limit: 1 }),
    });
    const a = new AbortController(),
      b = new AbortController();
    const qa = sessions.query("first", operation(first.id), a.signal);
    const failedA = assert.rejects(qa, /已取消/);
    await waitFor(() => sockets.length === 1);
    const firstSocket = sockets[0];
    const qb = sessions.query("second", operation(second.id), b.signal);
    const failedB = assert.rejects(qb, /已取消/);
    await waitFor(() => sockets.length === 2);
    const secondSocket = sockets[1];
    a.abort();
    await failedA;
    await waitFor(() => closed.has(firstSocket));
    assert(
      !closed.has(secondSocket),
      "other project's socket must remain alive",
    );
    b.abort();
    await failedB;
    await waitFor(() => closed.has(secondSocket));
    await assert.rejects(
      queryMongo(
        { ...config, query: { collection: "items" } },
        { signal: a.signal },
      ),
      /已取消/,
    );
    await delay(30);
    assert.equal(sockets.length, 2, "pre-cancelled work must not connect");
  },
);

test(
  "native script cancellation propagates to Mongo and preserves interrupted evidence",
  { timeout: 12000 },
  async (t) => {
    const { runNativeTaskPhase } = await import("../src/native-task-phase.mjs");
    const controller = new AbortController();
    let socket, peerClosed;
    const closed = new Promise((resolve) => {
      peerClosed = resolve;
    });
    const endpoint = net.createServer((peer) => {
      socket = peer;
      peer.on("error", () => {});
      peer.once("data", () => controller.abort());
      peer.once("close", peerClosed);
    });
    await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
    const sessions = new DatabaseSessions();
    t.after(async () => {
      sessions.close();
      socket?.destroy();
      await new Promise((resolve) => endpoint.close(resolve));
    });
    const grant = sessions.register("project", {
      type: "mongodb",
      name: "native cancel",
      host: "127.0.0.1",
      port: endpoint.address().port,
      database: "fixture",
    });
    const input = { variables: {}, environmentVariables: {} };
    await assert.rejects(
      runNativeTaskPhase(
        [
          {
            type: "database",
            enabled: 1,
            data: {
              connectionId: grant.id,
              query: '{"collection":"items","limit":1}',
              resultShape: "mongodb-document",
              isConsoleOutput: 0,
              variables: [
                {
                  name: "must_not_apply",
                  type: "environment",
                  pattern: "$.name",
                },
              ],
            },
          },
          {
            type: "customScript",
            enabled: 1,
            data: 'apt.environment.set("must_not_run",true);',
          },
        ],
        input,
        {
          signal: controller.signal,
          databaseQuery: (operation, signal) =>
            sessions.query("project", operation, signal),
        },
      ),
      (error) => {
        assert.match(error.message, /取消/);
        assert.equal(error.databaseQueries[0].status, "interrupted");
        return true;
      },
    );
    let timer;
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("cancelled Mongo socket did not close")),
          1500,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    assert.deepEqual(input, { variables: {}, environmentVariables: {} });
  },
);

test(
  "HTTP plan cancellation persists interrupted Mongo evidence without sending the request",
  { timeout: 15000 },
  async (t) => {
    const { createApp } = await import("../src/server.mjs");
    const { importIntoProject, snapshotPlan } = await import("../src/core.mjs");
    const { Store } = await import("../src/runtime.mjs");
    const { nativeMongoFixture } = await import(
      "./fixtures/apipost-mongodb.mjs"
    );
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { default: http } = await import("node:http");
    let calls = 0,
      handshake,
      closePeer;
    const started = new Promise((resolve) => {
      handshake = resolve;
    });
    const closed = new Promise((resolve) => {
      closePeer = resolve;
    });
    const sockets = [];
    const endpoint = net.createServer((socket) => {
      sockets.push(socket);
      socket.on("error", () => {});
      socket.once("data", handshake);
      socket.once("close", closePeer);
    });
    const echo = http.createServer((_req, res) => {
      calls++;
      res.end("{}");
    });
    await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
    const root = await mkdtemp(join(tmpdir(), "mongo-http-cancel-"));
    const app = await createApp({ root, port: 0 });
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      app.server.closeAllConnections();
      echo.closeAllConnections();
      await Promise.all(
        [endpoint, echo, app.server].map(
          (server) => new Promise((resolve) => server.close(resolve)),
        ),
      );
      await rm(root, { recursive: true, force: true });
    });
    const p = await app.store.create("Mongo cancellation");
    importIntoProject(
      p,
      nativeMongoFixture("http://127.0.0.1:" + echo.address().port),
    );
    p.plans = [
      snapshotPlan({
        id: "cancel-plan",
        name: "cancel",
        steps: [{ request: p.requests[0] }],
      }),
    ];
    await app.store.save(p);
    const headers = {
      "x-local-token": app.token,
      "content-type": "application/json",
    };
    const post = async (route, body) => {
      const response = await fetch(app.url + route, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    await post("/api/projects/" + p.id + "/database-connections", {
      type: "mongodb",
      name: "stall",
      host: "127.0.0.1",
      port: endpoint.address().port,
      database: "fixture",
      bindingId: p.settings.apipostDatabases[0].id,
    });
    const pending = post("/api/projects/" + p.id + "/run", {
      planId: p.plans[0].id,
      runId: "cancel-mongo-http",
    });
    let timer;
    await Promise.race([
      started,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Mongo handshake did not start")),
          1800,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    await post("/api/cancel", { id: "cancel-mongo-http" });
    const result = await pending;
    assert.equal(result.status, "cancelled", JSON.stringify(result));
    assert.equal(result.recordSaved, true);
    assert.equal(result.results[0].databaseQueries[0].status, "interrupted");
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Mongo socket did not close")),
          1500,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    const saved = await new Store(root).get(p.id);
    assert.equal(
      saved.runs.find((run) => run.id === result.id).status,
      "cancelled",
    );
    assert.equal(saved.environments[0].variables.native_value, undefined);
    assert.equal(calls, 0);
  },
);
