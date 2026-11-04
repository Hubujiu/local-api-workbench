import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/server.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const repo = fileURLToPath(new URL("..", import.meta.url));

test(
  "IF iterationData: owner, official HTTP/stdio SDK, CLI, backup/restart and staged load preserve true/false/true without scope writes",
  { timeout: 30000 },
  async (t) => {
    const seen = [];
    const peer = createServer((req, res) => {
      seen.push(req.url);
      res.end("ok");
    });
    await new Promise((r) => peer.listen(0, "127.0.0.1", r));
    const root = await mkdtemp(join(tmpdir(), "if-data-e2e-"));
    let app = await createApp({ root, port: 0 });
    const clients = [];
    const close = async (app) => {
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
    };
    t.after(async () => {
      for (const c of clients) await c.close().catch(() => {});
      await close(app);
      peer.closeAllConnections();
      await new Promise((r) => peer.close(r));
      await rm(root, { recursive: true, force: true });
    });
    const call = async (route, body, expected = 200) => {
      const r = await fetch(app.url + "/api/" + route, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const v = await r.json();
      assert.equal(r.status, expected, JSON.stringify(v));
      return v;
    };
    const p = await app.store.create("IF data");
    p.globalVariables = { selected: false };
    await app.store.save(p);
    const unrelated = await app.store.create("untouched");
    const untouched = await app.store.get(unrelated.id);
    const input = {
      name: "row selection",
      steps: [
        {
          type: "repeat",
          id: "rows",
          count: 3,
          intervalMs: 1,
          rows: [{ selected: true }, { selected: false }, { selected: true }],
          steps: [
            {
              type: "if",
              id: "gate",
              condition: {
                op: "eq",
                left: { scope: "iterationData", name: "selected" },
                right: { literal: true },
              },
              steps: [
                {
                  id: "accepted",
                  request: {
                    method: "GET",
                    url: `http://127.0.0.1:${peer.address().port}/accepted`,
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const plan = await call(`projects/${p.id}/plans`, input);
    const inspect = (run) => {
      assert.equal(run.status, "passed", JSON.stringify(run));
      assert.deepEqual(
        run.conditionResults.map((r) => r.matched),
        [true, false, true],
      );
      assert.deepEqual(
        run.results.map((r) => r.repeat.iteration),
        [0, 2],
      );
      assert.equal(run.results.length, 2);
      assert.ok(
        run.conditionResults.every((r) => !("left" in r) && !("right" in r)),
      );
    };
    inspect(await call(`projects/${p.id}/run`, { planId: plan.id }));
    assert.deepEqual(seen, ["/accepted", "/accepted"]);
    const config = await call("mcp/config", {
      enabled: true,
      projects: [p.id],
      write: true,
      execute: true,
      remember: false,
    });
    for (const transport of ["http", "stdio"]) {
      const client = new Client({
        name: "if-data-independent-e2e",
        version: "1",
      });
      clients.push(client);
      await client.connect(
        transport === "http"
          ? new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
              requestInit: {
                headers: { Authorization: "Bearer " + config.token },
              },
            })
          : new StdioClientTransport({
              command: process.execPath,
              args: [
                repo + "/src/mcp.mjs",
                "--project",
                p.id,
                "--write",
                "--execute",
              ],
              env: { ...process.env, LOCAL_API_DATA: root },
              stderr: "pipe",
            }),
      );
      const result = await client.callTool({
        name: "localapi_run_plan",
        arguments: { projectId: p.id, planId: plan.id },
      });
      assert.notEqual(result.isError, true, result.content?.[0]?.text);
      inspect(JSON.parse(result.content[0].text));
      await client.close();
    }
    assert.equal(seen.length, 6);
    const backup = await call(`projects/${p.id}/export`);
    const restored = await call("restore", { document: backup }, 201);
    assert.deepEqual(restored.plans[0].steps, plan.steps);
    assert.equal(seen.length, 6, "restore must not replay");
    await close(app);
    app = await createApp({ root, port: 0 });
    assert.equal(seen.length, 6, "restart must not replay");
    inspect(await call(`projects/${restored.id}/run`, { planId: plan.id }));
    const cli = await promisify(execFile)(
      process.execPath,
      [
        repo + "/scripts/run-plan.mjs",
        "--project",
        restored.id,
        "--plan",
        plan.id,
      ],
      {
        cwd: repo,
        env: { ...process.env, LOCAL_API_DATA: root },
        timeout: 10000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const cliRun = JSON.parse(cli.stdout);
    inspect(cliRun);
    assert.equal(cliRun.recordSaved, true);
    assert.equal(seen.length, 10);
    const saved = await app.store.get(restored.id);
    assert.deepEqual(saved.globalVariables, { selected: false });
    assert.equal(saved.runs.length, 5);
    for (const record of saved.runs) inspect(record);
    assert.deepEqual(saved.plans[0].steps, plan.steps);
    assert.deepEqual(await app.store.get(unrelated.id), untouched);
    const before = await call(`projects/${p.id}/export`);
    const bad = structuredClone(input);
    delete bad.steps[0].rows[2].selected;
    bad.steps.unshift({
      id: "must-not-send",
      request: { url: `http://127.0.0.1:${peer.address().port}/never` },
    });
    await call(`projects/${p.id}/plans`, bad, 400);
    assert.deepEqual(await call(`projects/${p.id}/export`), before);
    assert.equal(seen.length, 10);
    const beforeStaged = await app.store.get(restored.id);
    const response = await fetch(
      app.url + `/api/projects/${restored.id}/staged-load`,
      {
        method: "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          planId: plan.id,
          schedule: {
            initialVUs: 1,
            stages: [{ durationSeconds: 2, targetVUs: 1 }],
            maxIterations: 2,
          },
        }),
      },
    );
    const stream = await response.text();
    assert.equal(response.status, 200, stream);
    const events = stream
      .trim()
      .split("\n\n")
      .map((e) => {
        const [name, data] = e.split("\n");
        return { name: name.slice(7), value: JSON.parse(data.slice(6)) };
      });
    assert.equal(events.at(-1).name, "complete");
    assert.equal(events.at(-1).value.stopReason, "iteration-limit");
    assert.equal(events.at(-2).name, "reportEnd");
    assert.equal(events.at(-2).value.mainRequests, 4);
    assert.deepEqual(await app.store.get(restored.id), beforeStaged);
    assert.equal(seen.length, 14, stream);
    assert.ok(seen.every((p) => p === "/accepted"));
    assert.deepEqual((await app.store.get(restored.id)).globalVariables, {
      selected: false,
    });
    assert.deepEqual(await app.store.get(unrelated.id), untouched);
  },
);
