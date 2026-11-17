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
  "IF contains/notContains: owner, official HTTP/stdio SDK, CLI, backup/restart and staged load route matching/nonmatching rows without scope writes",
  { timeout: 30000 },
  async (t) => {
    const seen = [];
    const peer = createServer((req, res) => {
      seen.push(req.url);
      res.end("ok");
    });
    await new Promise((r) => peer.listen(0, "127.0.0.1", r));
    const root = await mkdtemp(join(tmpdir(), "if-text-e2e-"));
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
          rows: [
            { selected: "Hello 世界 .*" },
            { selected: "hello 世界" },
            { selected: ".* literal" },
          ],
          steps: [
            {
              type: "if",
              id: "gate",
              condition: {
                op: "contains",
                left: { scope: "iterationData", name: "selected" },
                right: { literal: ".*" },
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
    const negative = structuredClone(input.steps[0].steps[0]);
    negative.id = "negative";
    negative.condition.op = "notContains";
    negative.steps[0].id = "absent";
    negative.steps[0].request.url = `http://127.0.0.1:${peer.address().port}/absent`;
    input.steps[0].steps.push(negative);
    const plan = await call(`projects/${p.id}/plans`, input);
    const inspect = (run) => {
      assert.equal(run.status, "passed", JSON.stringify(run));
      assert.deepEqual(
        run.conditionResults.map((r) => r.matched),
        [true, false, false, true, true, false],
      );
      assert.deepEqual(
        run.results.map((r) => r.repeat.iteration),
        [0, 1, 2],
      );
      assert.equal(run.results.length, 3);
      assert.ok(
        run.conditionResults.every((r) => !("left" in r) && !("right" in r)),
      );
    };
    inspect(await call(`projects/${p.id}/run`, { planId: plan.id }));
    assert.deepEqual(seen, ["/accepted", "/absent", "/accepted"]);
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
    assert.equal(seen.length, 9);
    const backup = await call(`projects/${p.id}/export`);
    const restored = await call("restore", { document: backup }, 201);
    assert.deepEqual(restored.plans[0].steps, plan.steps);
    assert.equal(seen.length, 9, "restore must not replay");
    await close(app);
    app = await createApp({ root, port: 0 });
    assert.equal(seen.length, 9, "restart must not replay");
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
    assert.equal(seen.length, 15);
    const saved = await app.store.get(restored.id);
    assert.deepEqual(saved.globalVariables, { selected: false });
    assert.equal(saved.runs.length, 5);
    for (const record of saved.runs) inspect(record);
    assert.deepEqual(saved.plans[0].steps, plan.steps);
    assert.deepEqual(await app.store.get(unrelated.id), untouched);
    const before = await call(`projects/${p.id}/export`);
    const bad = structuredClone(input);
    bad.steps[0].rows[2].selected = 42424242;
    bad.steps.unshift({
      id: "must-not-send",
      request: { url: `http://127.0.0.1:${peer.address().port}/never` },
    });
    const rejection = await call(`projects/${p.id}/plans`, bad, 400);
    assert.ok(!JSON.stringify(rejection).includes("42424242"));
    assert.ok(!JSON.stringify(rejection).includes("Hello 世界"));
    assert.deepEqual(await call(`projects/${p.id}/export`), before);
    assert.equal(seen.length, 15);
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
    assert.equal(events.at(-2).value.mainRequests, 6);
    assert.deepEqual(await app.store.get(restored.id), beforeStaged);
    assert.equal(seen.length, 21, stream);
    assert.deepEqual(
      seen,
      Array.from({ length: 7 }, () => [
        "/accepted",
        "/absent",
        "/accepted",
      ]).flat(),
    );
    assert.deepEqual((await app.store.get(restored.id)).globalVariables, {
      selected: false,
    });
    assert.deepEqual(await app.store.get(unrelated.id), untouched);
    const wrong = await app.store.get(p.id);
    wrong.globalVariables.wrongType = 42424242;
    await app.store.save(wrong);
    for (const op of ["contains", "notContains"]) {
      const invalid = await call(`projects/${p.id}/plans`, {
        name: "runtime type refusal",
        steps: [
          {
            id: "bad-gate",
            type: "if",
            condition: {
              op,
              left: { scope: "globals", name: "wrongType" },
              right: { literal: "private-fixture-marker" },
            },
            steps: [
              {
                id: "never",
                request: {
                  url: `http://127.0.0.1:${peer.address().port}/never`,
                },
              },
            ],
          },
        ],
      });
      const failed = await call(`projects/${p.id}/run`, { planId: invalid.id });
      assert.equal(failed.status, "failed");
      assert.equal(failed.stopReason, "condition-error");
      assert.equal(failed.results.length, 0);
      assert.equal(failed.conditionResults.length, 1);
      assert.equal(failed.conditionResults[0].code, "PLAN_CONDITION_INVALID");
      const diagnostics = JSON.stringify(failed.conditionResults);
      assert.ok(!diagnostics.includes("42424242"));
      assert.ok(!diagnostics.includes("private-fixture-marker"));
      assert.equal(seen.length, 21);
      const stored = await app.store.get(p.id);
      const persisted = stored.runs.find((r) => r.id === failed.id);
      assert.deepEqual(persisted.conditionResults, failed.conditionResults);
    }
  },
);
