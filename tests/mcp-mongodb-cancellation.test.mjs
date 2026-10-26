// Cross-feature acceptance: PR9/10 native Mongo grants + PR19 HTTP cancellation.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { importIntoProject, snapshotPlan } from "../src/core.mjs";
import { nativeMongoFixture } from "./fixtures/apipost-mongodb.mjs";
const waitFor = async (predicate) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
  throw Error("Mongo SDK cancellation observation did not arrive");
};
test(
  "SDK cancellation stops native Mongo worker sockets and persists interrupted API/plan evidence",
  { timeout: 18000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "mcp-mongo-cancel-"));
    const app = await createApp({ root, port: 0 });
    const sockets = new Set();
    let handshakes = 0,
      httpCalls = 0;
    const stall = net.createServer((socket) => {
      sockets.add(socket);
      socket.once("data", () => handshakes++);
      socket.on("error", () => {});
      socket.once("close", () => sockets.delete(socket));
    });
    const echo = http.createServer((_req, res) => {
      httpCalls++;
      res.end("{}");
    });
    await new Promise((resolve) => stall.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
    const client = new Client({ name: "native-mongo-cancel", version: "1" });
    t.after(async () => {
      await client.close().catch(() => {});
      for (const socket of sockets) socket.destroy();
      echo.closeAllConnections();
      app.server.closeAllConnections();
      await Promise.all(
        [stall, echo, app.server].map(
          (server) => new Promise((resolve) => server.close(resolve)),
        ),
      );
      await rm(root, { recursive: true, force: true });
    });
    const p = await app.store.create("cancelled native Mongo");
    importIntoProject(
      p,
      nativeMongoFixture("http://127.0.0.1:" + echo.address().port),
    );
    p.plans = [
      snapshotPlan({
        id: "plan",
        name: "plan",
        steps: [{ request: p.requests[0] }],
      }),
    ];
    await app.store.save(p);
    const headers = {
      "x-local-token": app.token,
      "content-type": "application/json",
    };
    const post = async (route, data) => {
      const response = await fetch(app.url + route, {
        method: "POST",
        headers,
        body: JSON.stringify(data),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const config = await post("/api/mcp/config", {
      enabled: true,
      projects: [p.id],
      write: true,
      execute: true,
    });
    await post("/api/projects/" + p.id + "/mcp-database-connections", {
      type: "mongodb",
      name: "ephemeral cancellation fixture",
      host: "127.0.0.1",
      port: stall.address().port,
      database: "fixture",
      bindingId: p.settings.apipostDatabases[0].id,
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(app.url + "/mcp"),
      {
        requestInit: { headers: { Authorization: "Bearer " + config.token } },
      },
    );
    await client.connect(transport);
    const sessionId = transport.sessionId;
    for (const [name, args, collection] of [
      [
        "localapi_execute_api",
        { projectId: p.id, apiId: p.requests[0].id },
        "history",
      ],
      [
        "localapi_execute_flow",
        { projectId: p.id, planId: p.plans[0].id },
        "runs",
      ],
    ]) {
      const previous = handshakes,
        controller = new AbortController();
      const rejected = assert.rejects(
        client.callTool({ name, arguments: args }, undefined, {
          signal: controller.signal,
        }),
        /abort|cancel/i,
      );
      await waitFor(() => handshakes > previous);
      controller.abort();
      await rejected;
      await waitFor(async () =>
        (await new Store(root).get(p.id))[collection].some(
          (record) => record.status === "cancelled",
        ),
      );
      await waitFor(() => sockets.size === 0);
      const saved = await new Store(root).get(p.id);
      const record = saved[collection].find(
        (record) => record.status === "cancelled",
      );
      const query =
        collection === "runs"
          ? record.results[0].databaseQueries[0]
          : record.databaseQueries[0];
      assert.equal(query.status, "interrupted");
      assert.equal(saved.environments[0].variables.native_value, undefined);
      assert.equal(httpCalls, 0);
      assert(!JSON.stringify(saved).includes(sessionId));
      await client.ping();
    }
  },
);
