// CI-only ordinary cancellation acceptance, not a local execution target.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { installScopeSaveLockGate } from "./helpers/scope-save-lock-gate.mjs";
async function waitFor(read) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline)
      throw Error("collection cancellation observation timed out");
    await delay(10);
  }
}
async function marker(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
for (const mode of ["owner", "http", "stdio"])
  test(
    `${mode} collection stage cancellation behind real Store lock preserves prior commit, terminal evidence and restart isolation`,
    { timeout: 30000 },
    async (t) => {
      const temporary = await mkdtemp(
          path.join(tmpdir(), "collection-cancel-"),
        ),
        root = path.join(temporary, "data"),
        gate = path.join(temporary, "gate");
      await mkdir(gate);
      const seen = [];
      const wire = http.createServer((req, res) => {
        seen.push(req.url);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ path: req.url }));
      });
      await new Promise((resolve) => wire.listen(0, "127.0.0.1", resolve));
      let app = await createApp({ root, port: 0 }),
        client,
        undo,
        pending,
        controller,
        cancelAck,
        activeProjectId,
        activePlanId;
      t.after(async () => {
        controller?.abort();
        await Promise.all(
          ["pre", "post"].map((label) =>
            writeFile(path.join(gate, label + ".release"), "release").catch(
              () => {},
            ),
          ),
        );
        if (mode === "owner")
          await fetch(app.url + "/api/cancel", {
            method: "POST",
            headers: {
              "x-local-token": app.token,
              "content-type": "application/json",
            },
            body: JSON.stringify({ id: "collection-cancel" }),
          }).catch(() => {});
        await pending?.catch(() => {});
        if (activeProjectId && activePlanId)
          await waitFor(async () => {
            const current = await new Store(root).get(activeProjectId);
            return current.runs.some(
              (run) => run.planId === activePlanId && run.status !== "running",
            );
          }).catch(() => {});
        await client?.close().catch(() => {});
        undo?.();
        app.server.closeAllConnections();
        wire.closeAllConnections();
        await Promise.all(
          [app.server, wire].map((s) => new Promise((r) => s.close(r))),
        );
        await rm(temporary, { recursive: true, force: true });
      });
      const owner = async (route, method = "GET", body, status = 200) => {
        const response = await fetch(app.url + route, {
          method,
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const value = await response.json();
        assert.equal(response.status, status, JSON.stringify(value));
        return value;
      };
      const p = await app.store.create("Collection queued saves"),
        base = "http://127.0.0.1:" + wire.address().port;
      const imported = await owner(`/api/projects/${p.id}/import`, "POST", {
        postmanVariableMode: "collection",
        document: {
          info: { name: "Collection" },
          item: [
            {
              name: "bound",
              request: { method: "GET", url: { raw: base + "/main" } },
            },
          ],
          variable: [
            { key: "value", value: "old" },
            { key: "kept", value: "old" },
          ],
        },
      });
      activeProjectId = p.id;
      const bound = imported.requests[0],
        collectionId = bound.postmanCollectionId;
      for (const phase of ["pre", "post"]) {
        const edit = `pm.collectionVariables.set('value','new');pm.environment.set('scopeGate','${phase}');`;
        await owner(`/api/projects/${p.id}/plans`, "POST", {
          id: "flow-" + phase,
          name: phase,
          environmentId: p.environments[0].id,
          steps: [
            {
              id: "first",
              request: {
                ...bound,
                url: base + "/" + phase,
                beforeScript:
                  phase === "pre"
                    ? edit
                    : "pm.collectionVariables.set('kept','pre-committed');",
                afterScript: phase === "post" ? edit : "",
              },
            },
            { id: "later", request: { ...bound, url: base + "/later" } },
          ],
        });
      }
      if (mode !== "stdio") undo = installScopeSaveLockGate(app.store, gate);
      if (mode !== "owner") {
        client = new Client({
          name: "collection-cancel-" + mode,
          version: "1",
        });
        let transport;
        if (mode === "http") {
          const config = await owner("/api/mcp/config", "POST", {
            enabled: true,
            projects: [p.id],
            write: true,
            execute: true,
          });
          transport = new StreamableHTTPClientTransport(
            new URL(app.url + "/mcp"),
            {
              requestInit: {
                headers: { Authorization: "Bearer " + config.token },
              },
              fetch: async (url, init) => {
                const message =
                  typeof init?.body === "string" ? JSON.parse(init.body) : null;
                const response = await fetch(url, init);
                if (message?.method === "notifications/cancelled")
                  cancelAck?.resolve(response.status);
                return response;
              },
            },
          );
        } else
          transport = new StdioClientTransport({
            command: process.execPath,
            args: [
              "--import",
              new URL("./helpers/scope-save-lock-preload.mjs", import.meta.url)
                .href,
              fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
              "--project",
              p.id,
              "--write",
              "--execute",
            ],
            env: { LOCAL_API_DATA: root, LOCAL_API_SCOPE_GATE: gate },
            stderr: "pipe",
          });
        await client.connect(transport);
        assert(
          (await client.listTools()).tools.some(
            (tool) => tool.name === "localapi_execute_flow",
          ),
        );
      }
      for (const phase of ["pre", "post"]) {
        const before = await app.store.get(p.id);
        await writeFile(
          path.join(gate, "armed.json"),
          JSON.stringify({ projectId: p.id, label: phase }),
        );
        activePlanId = "flow-" + phase;
        controller = new AbortController();
        cancelAck = Promise.withResolvers();
        pending =
          mode === "owner"
            ? owner(`/api/projects/${p.id}/run`, "POST", {
                planId: "flow-" + phase,
                runId: "collection-cancel",
              })
            : client.callTool(
                {
                  name: "localapi_execute_flow",
                  arguments: { projectId: p.id, planId: "flow-" + phase },
                },
                undefined,
                { signal: controller.signal },
              );
        const outcome = pending.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        const checkpoint = await waitFor(() =>
          marker(path.join(gate, phase + ".ready")),
        );
        assert.equal(checkpoint.settled, false);
        assert.equal(checkpoint.signalForwarded, true);
        if (mode === "owner")
          await owner("/api/cancel", "POST", { id: "collection-cancel" });
        else {
          controller.abort();
          assert.match(String((await outcome).error), /abort|cancel/i);
          if (mode === "http") assert.equal(await cancelAck.promise, 202);
          await client.ping();
        }
        await writeFile(path.join(gate, phase + ".release"), "release");
        const saved = await waitFor(async () => {
          const value = await new Store(root).get(p.id);
          return (
            value.runs.some(
              (run) =>
                run.planId === "flow-" + phase && run.status === "cancelled",
            ) && value
          );
        });
        if (mode === "owner") {
          const answer = await outcome;
          assert.equal(answer.error, undefined);
          assert.equal(answer.value.status, "cancelled");
          assert.equal(answer.value.recordSaved, true);
        }
        const collection = saved.postmanCollections.items.find(
          (item) => item.id === collectionId,
        );
        assert.equal(collection.variables.value, "old");
        assert.equal(
          collection.variables.kept,
          phase === "post" ? "pre-committed" : "old",
        );
        assert.equal(
          saved.configRevision,
          before.configRevision + (phase === "post" ? 1 : 0),
        );
        assert.equal(saved.environments[0].variables.scopeGate, undefined);
        assert.deepEqual(saved.plans, before.plans);
        const run = saved.runs.find((item) => item.planId === "flow-" + phase);
        assert.equal(run.results.length, 1);
        assert.match(run.results[0].error, /取消/);
        assert.equal(Boolean(run.results[0].response), phase === "post");
        if (client) {
          const read = decode(
            await client.callTool({
              name: "localapi_get_execution_result",
              arguments: { projectId: p.id, runId: run.id },
            }),
          );
          assert.deepEqual(read.results, run.results);
          assert.equal(read.planHash, run.planHash);
        }
      }
      assert.deepEqual(seen, ["/post"]);
      await client?.close();
      undo?.();
      undo = undefined;
      const backup = await owner(`/api/projects/${p.id}/export`),
        restored = await owner(
          "/api/restore",
          "POST",
          { document: backup },
          201,
        );
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
      app = await createApp({ root, port: 0 });
      const read = await owner(`/api/projects/${restored.id}`);
      assert.deepEqual(read.postmanCollections, backup.postmanCollections);
      assert.deepEqual(read.runs, backup.runs);
      assert.deepEqual(seen, ["/post"]);
    },
  );
