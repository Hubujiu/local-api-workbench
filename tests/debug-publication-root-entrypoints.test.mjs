import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/server.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const decode = (r) => {
  assert.notEqual(r.isError, true, r.content?.[0]?.text);
  return JSON.parse(r.content[0].text);
};
for (const mode of ["http", "stdio"])
  test(
    `root ${mode} SDK native/canonical concurrent publications preserve both receipts and wire evidence`,
    { timeout: 15000 },
    async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "debug-root-"));
      const gates = new Map(),
        counts = new Map();
      const upstream = http.createServer(async (req, res) => {
        const key = req.url.slice(1);
        counts.set(key, (counts.get(key) || 0) + 1);
        const gate = gates.get(key);
        if (gate) {
          gate.arrived.resolve();
          await gate.release.promise;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token: key }));
      });
      await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
      const app = await createApp({ root, port: 0 });
      const c = new Client(
        { name: "root-debug-publication", version: "1.0.0" },
        { capabilities: {} },
      );
      t.after(async () => {
        for (const gate of gates.values()) gate.release.resolve();
        await c.close().catch(() => {});
        app.server.closeAllConnections();
        upstream.closeAllConnections();
        await Promise.all([
          new Promise((r) => app.server.close(r)),
          new Promise((r) => upstream.close(r)),
        ]);
        await rm(root, { recursive: true, force: true });
      });
      const p = await app.store.create("root publication");
      p.requests = ["slow", "fast", "clear", "edit"].map((id) => ({
        id,
        name: id,
        method: "GET",
        url: `http://127.0.0.1:${upstream.address().port}/${id}`,
        extract: [{ name: "token", path: "$.token" }],
      }));
      await app.store.save(p);
      const owner = async (action, method = "GET", data) => {
        const r = await fetch(`${app.url}/api/projects/${p.id}/${action}`, {
          method,
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          body: data === undefined ? undefined : JSON.stringify(data),
        });
        assert.equal(r.status, 200, await r.clone().text());
        return r.json();
      };
      if (mode === "http") {
        const r = await fetch(app.url + "/api/mcp/config", {
          method: "POST",
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            enabled: true,
            projects: [p.id],
            write: true,
            execute: true,
            remember: false,
          }),
        });
        assert.equal(r.status, 200);
        const config = await r.json();
        await c.connect(
          new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
            requestInit: {
              headers: { Authorization: "Bearer " + config.token },
            },
          }),
        );
      } else
        await c.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [
              fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
              "--project",
              p.id,
              "--execute",
              "--write",
            ],
            env: { LOCAL_API_DATA: root },
            stderr: "pipe",
          }),
        );
      const native = (id) =>
        c
          .callTool({
            name: "apipost_execute_api",
            arguments: { project_id: p.id, target_id: id },
          })
          .then(decode);
      const canonical = (id) =>
        c
          .callTool({
            name: "localapi_execute_api",
            arguments: { projectId: p.id, apiId: id },
          })
          .then(decode);
      const runtime = () =>
        c
          .callTool({
            name: "localapi_get_environment_variables",
            arguments: { projectId: p.id },
          })
          .then(decode);
      const hold = (key) => {
        const gate = {
          arrived: Promise.withResolvers(),
          release: Promise.withResolvers(),
        };
        gates.set(key, gate);
        return gate;
      };
      const gate = hold("slow"),
        pending = native("slow");
      await gate.arrived.promise;
      const fast = await canonical("fast");
      assert.equal(fast.recordSaved, true);
      assert.equal(fast.recordId, fast.id);
      assert.equal(fast.results[0].response.status, 200);
      gate.release.resolve();
      const slow = await pending;
      assert.equal(slow.status, "passed");
      assert.equal(slow.record_saved, true);
      assert.equal(slow.record_id, slow.run_id);
      assert.equal((await runtime()).runtimeVariables.token, "fast");
      const saved = await app.store.get(p.id);
      for (const [id, token] of [
        [fast.id, "fast"],
        [slow.run_id, "slow"],
      ]) {
        const record = saved.history.find((h) => h.id === id);
        assert(record);
        assert.equal(record.response.status, 200);
        assert.equal(JSON.parse(record.response.body).token, token);
        assert.equal(record.extracted.token, token);
      }
      assert.equal(counts.get("slow"), 1);
      assert.equal(counts.get("fast"), 1);
      if (mode === "http") {
        for (const action of ["clear", "edit"]) {
          const gate = hold(action),
            pending = native(action);
          await gate.arrived.promise;
          if (action === "clear") await owner("clear-session", "POST", {});
          else {
            const before = await owner("debug-variables");
            await owner("debug-variables", "PUT", {
              ...before,
              variables: { token: "manual" },
            });
          }
          gate.release.resolve();
          const result = await pending;
          assert.equal(result.record_saved, true);
          assert.equal(result.status, "passed");
          assert.equal(
            (await runtime()).runtimeVariables.token,
            action === "clear" ? undefined : "manual",
          );
          const record = (await app.store.get(p.id)).history.find(
            (h) => h.id === result.run_id,
          );
          assert.equal(JSON.parse(record.response.body).token, action);
          assert.equal(counts.get(action), 1);
        }
      } else {
        // Owner HTTP and stdio deliberately own different caches.
        assert.equal(
          (await owner("debug-variables")).variables.token,
          undefined,
        );
        await owner("clear-session", "POST", {});
        assert.equal((await runtime()).runtimeVariables.token, "fast");
      }
    },
  );
