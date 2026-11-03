import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { snapshotPlan } from "../src/core.mjs";
import { acquireFileLock } from "../src/file-lock.mjs";
import { MCPConfigPublication } from "../src/mcp-config-publication.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function bounded(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(label)), 5000);
    }),
  ]).finally(() => clearTimeout(timer));
}

for (const mode of ["stateful", "stateless"])
  test(
    `immediate project fence aborts ${mode} execution before owner publication can finish`,
    { timeout: 20000 },
    async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "mcp-fence-cancel-"));
      const app = await createApp({ root, port: 0 });
      const entered = deferred(),
        closed = deferred();
      const seen = [];
      let held, release;
      const outcomes = [];
      const upstream = http.createServer((request, response) => {
        seen.push(request.url);
        response.setHeader("content-type", "application/json");
        if (request.url === "/held") {
          held = response;
          response.once("close", () => closed.resolve());
          entered.resolve();
        } else response.end("{}");
      });
      await new Promise((done) => upstream.listen(0, "127.0.0.1", done));
      t.after(async () => {
        // Abort server execution before releasing held work, then join live handlers.
        const closing = new Promise((done) => app.server.close(done));
        await release?.();
        held?.end("{}");
        try {
          await bounded(
            Promise.allSettled(outcomes),
            "fixture requests did not settle",
          );
          await bounded(closing, "fixture server did not close");
        } catch (error) {
          app.server.closeAllConnections();
          upstream.closeAllConnections();
          await new Promise((done) => upstream.close(done));
          throw error; // Keep evidence files if a real handler has not settled.
        }
        upstream.closeAllConnections();
        await new Promise((done) => upstream.close(done));
        await rm(root, { recursive: true, force: true });
      });
      const base = "http://127.0.0.1:" + upstream.address().port;
      const a = await app.store.create("Revoked active project");
      const b = await app.store.create("Retained project");
      for (const [project, paths] of [
        [a, ["/held", "/later"]],
        [b, ["/retained"]],
      ]) {
        project.plans = [
          snapshotPlan({
            id: "flow",
            name: "flow",
            steps: paths.map((suffix) => ({
              request: {
                name: suffix,
                method: "GET",
                url: base + suffix,
                timeout: 10000,
              },
            })),
          }),
        ];
        await app.store.save(project);
      }
      const owner = async (config) => {
        const response = await fetch(app.url + "/api/mcp/config", {
          method: config === undefined ? "GET" : "POST",
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          ...(config === undefined ? {} : { body: JSON.stringify(config) }),
        });
        return { status: response.status, value: await response.json() };
      };
      const config = {
        enabled: true,
        remember: true,
        write: true,
        execute: true,
        projects: [a.id, b.id],
      };
      const granted = await owner(config);
      assert.equal(granted.status, 200);
      const before = await readFile(path.join(root, ".mcp-config.json"));
      let session;
      const rpc = async (message) => {
        const response = await fetch(app.url + "/mcp", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + granted.value.token,
            "content-type": "application/json",
            ...(session ? { "mcp-session-id": session } : {}),
          },
          body: JSON.stringify(message),
        });
        return {
          status: response.status,
          session: response.headers.get("mcp-session-id"),
          value: await response.json(),
        };
      };
      if (mode === "stateful") {
        const initialized = await rpc({
          jsonrpc: "2.0",
          id: "init",
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "synthetic-fence-fixture", version: "1" },
          },
        });
        assert.equal(initialized.status, 200);
        session = initialized.session;
        assert.equal(typeof session, "string");
      }
      const call = (projectId, id) =>
        rpc({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name: "localapi_execute_flow",
            arguments: { projectId, planId: "flow" },
          },
        });
      const pending = call(a.id, "active");
      outcomes.push(pending);
      await bounded(entered.promise, "actual upstream request did not begin");
      release = await acquireFileLock(app.store.lockFile(b.id));
      let admitted;
      const original = MCPConfigPublication.prototype.run;
      t.mock.method(
        MCPConfigPublication.prototype,
        "run",
        function (operation) {
          const task = original.call(this, operation);
          admitted?.();
          return task;
        },
      );
      const submit = async (value) => {
        const reached = new Promise((done) => {
          admitted = done;
        });
        const index = outcomes.length;
        outcomes.push(owner(value));
        await bounded(reached, "owner did not join real FIFO");
        return index;
      };
      const old = await submit(config);
      const fence = await submit({ ...config, projects: [b.id] });
      let acknowledged = false;
      outcomes[fence].then(
        () => {
          acknowledged = true;
        },
        () => {
          acknowledged = true;
        },
      );
      await bounded(
        closed.promise,
        "held network request was not aborted before publication",
      );
      const terminal = await bounded(
        pending,
        "cancelled execution did not settle",
      );
      assert.equal(
        acknowledged,
        false,
        "no owner success while FIFO is blocked",
      );
      assert.equal(terminal.value.error?.code, -32000);
      assert.deepEqual(seen, ["/held"]);
      const saved = await app.store.get(a.id);
      assert.equal(saved.runs.length, 1);
      assert.equal(saved.runs[0].status, "cancelled");
      assert.equal(saved.runs[0].source, "mcp");
      const state = (await owner()).value;
      assert.deepEqual(state.projects, [b.id]);
      assert.equal(state.write, true);
      assert.equal(state.execute, true);
      const activity = state.activities.find(
        (item) =>
          item.projectId === a.id && item.tool === "localapi_execute_flow",
      );
      assert.equal(activity.status, "cancelled");
      assert.equal(activity.recordSaved, true);
      assert.equal(
        (await readFile(path.join(root, ".mcp-config.json"))).equals(before),
        true,
      );
      await release();
      release = null;
      assert.equal((await outcomes[old]).status, 400);
      assert.equal((await outcomes[fence]).status, 200);
      const retained = await call(b.id, "retained");
      assert.notEqual(retained.value.result?.isError, true);
      assert.equal(retained.value.error, undefined);
      assert.equal((await app.store.get(b.id)).runs[0].status, "passed");
      assert.deepEqual(seen, ["/held", "/retained"]);
      assert.deepEqual(
        JSON.parse(await readFile(path.join(root, ".mcp-config.json"), "utf8"))
          .projects,
        [b.id],
      );
    },
  );
