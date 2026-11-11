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
import {
  observeToolCall,
  toolCallFailureDiagnostic,
} from "./helpers/mcp-cancellation-observation.mjs";
import { mongoHandshakeGate } from "./helpers/mongo-handshake-gate.mjs";
const waitFor = async (predicate) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
  throw Error("Mongo SDK cancellation observation did not arrive");
};
for (const cancel of [true, false])
  test(
    cancel
      ? "SDK cancellation stops native Mongo worker sockets and persists interrupted API/plan evidence"
      : "Mongo total deadline remains failed/interrupted without fixture cancellation",
    { timeout: 18000 },
    async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), "mcp-mongo-cancel-"));
      const app = await createApp({ root, port: 0 });
      const sockets = new Set();
      let httpCalls = 0;
      const stalls = new Set();
      const echo = http.createServer((_req, res) => {
        httpCalls++;
        res.end("{}");
      });
      await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
      const client = new Client({ name: "native-mongo-cancel", version: "1" });
      t.after(async () => {
        await client.close().catch(() => {});
        for (const socket of sockets) socket.destroy();
        echo.closeAllConnections();
        app.server.closeAllConnections();
        await Promise.all(
          [...stalls, echo, app.server].map(
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
      const post = async (route, data, method = "POST") => {
        const response = await fetch(app.url + route, {
          method,
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
        [
          "apipost_execute_api",
          { project_id: p.id, target_id: p.requests[0].id },
          "history",
        ],
        [
          "apipost_execute_flow",
          { project_id: p.id, flow_id: p.plans[0].id },
          "runs",
        ],
      ]) {
        const controller = new AbortController();
        const gate = mongoHandshakeGate(controller, { cancel });
        t.after(() => {
          gate.dispose();
          controller.abort();
          t.diagnostic(gate.diagnostic());
        });
        // A distinct listener/port for each operation prevents a late connection
        // from a prior call from satisfying (or cancelling) a later epoch.
        // Keep prior listeners reserved until teardown to prevent port reuse.
        const stall = net.createServer((socket) => {
          sockets.add(socket);
          gate.accepted();
          socket.once("data", () => gate.data());
          socket.on("error", () => {});
          socket.once("close", () => {
            sockets.delete(socket);
            gate.closed();
          });
        });
        stalls.add(stall);
        await new Promise((resolve) => stall.listen(0, "127.0.0.1", resolve));
        const grant = await post(
          "/api/projects/" + p.id + "/mcp-database-connections",
          {
            type: "mongodb",
            name: "ephemeral cancellation fixture",
            host: "127.0.0.1",
            port: stall.address().port,
            database: "fixture",
            bindingId: p.settings.apipostDatabases[0].id,
          },
        );
        const expectedStatus = cancel ? "cancelled" : "failed";
        const oldIDs = new Set(
          (await app.store.get(p.id))[collection].map((record) => record.id),
        );
        const observation = observeToolCall(
          client.callTool({ name, arguments: args }, undefined, {
            signal: controller.signal,
          }),
        );
        gate.attach(observation);
        try {
          await gate.ready;
          if (cancel)
            await assert.rejects(async () => {
              const terminal = await observation.completion;
              if (terminal.kind === "rejected") throw terminal.reason;
              return terminal.value;
            }, /abort|cancel/i);
          else {
            const terminal = await observation.completion;
            assert.equal(terminal.kind, "fulfilled");
            assert.equal(controller.signal.aborted, false);
          }
        } catch (error) {
          t.diagnostic(toolCallFailureDiagnostic(name, observation.terminal));
          throw error;
        } finally {
          gate.dispose();
          if (cancel) controller.abort();
        }
        await waitFor(async () =>
          (await new Store(root).get(p.id))[collection].some(
            (record) =>
              record.status === expectedStatus && !oldIDs.has(record.id),
          ),
        );
        await waitFor(() => sockets.size === 0);
        const saved = await new Store(root).get(p.id);
        const record = saved[collection].find(
          (record) =>
            record.status === expectedStatus && !oldIDs.has(record.id),
        );
        const query =
          collection === "runs"
            ? record.results[0].databaseQueries[0]
            : record.databaseQueries[0];
        assert.equal(query.status, "interrupted");
        if (!cancel) {
          const step = collection === "runs" ? record.results[0] : record;
          assert.equal(step.status, "failed");
          assert.equal(step.error, "脚本执行超时");
          assert.equal(step.scriptStage, "total-deadline");
        }
        assert.equal(saved.environments[0].variables.native_value, undefined);
        assert.equal(httpCalls, 0);
        assert(!JSON.stringify(saved).includes(sessionId));
        await waitFor(async () => {
          const state = await fetch(app.url + "/api/mcp/config", {
            headers,
          }).then((r) => r.json());
          return (
            state.lastActivity?.tool === name &&
            state.lastActivity?.status === expectedStatus
          );
        });
        const activity = await fetch(app.url + "/api/mcp/config", {
          headers,
        }).then((r) => r.json());
        assert.equal(activity.lastActivity.recordSaved, true);
        await client.ping();
        await post(
          "/api/projects/" + p.id + "/mcp-database-connections",
          { id: grant.id },
          "DELETE",
        );
      }
    },
  );
