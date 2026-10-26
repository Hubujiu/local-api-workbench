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
