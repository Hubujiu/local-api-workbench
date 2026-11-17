import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, rename, readFile, writeFile } from "node:fs/promises";
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
  "repeat until owner, official HTTP/stdio, CLI, restore and staged outcome accounting",
  { timeout: 30000 },
  async (t) => {
    const seen = [];
    let n = 0;
    const peer = createServer((req, res) => {
      seen.push(req.url);
      if (req.url === "/setup") n = 0;
      if (req.url === "/poll") n++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ n }));
    });
    await new Promise((r) => peer.listen(0, "127.0.0.1", r));
    const root = await mkdtemp(join(tmpdir(), "until-e2e-"));
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
      const response = await fetch(app.url + "/api/" + route, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await response.json();
      assert.equal(response.status, expected, JSON.stringify(value));
      return value;
    };
    const p = await app.store.create("until");
    const other = await app.store.create("unrelated");
    const otherBefore = await app.store.get(other.id);
    const url = `http://127.0.0.1:${peer.address().port}`;
    const leaf = (id) => ({
      id,
      request: {
        url: url + "/" + id,
        extract: [{ name: "n", source: "json", path: "$.n" }],
      },
    });
    const input = (target) => ({
      name: "until " + target,
      steps: [
        leaf("setup"),
        {
          type: "repeat",
          id: "loop",
          count: 3,
          intervalMs: 1,
          untilCondition: {
            op: "eq",
            left: { scope: "runtime", name: "n" },
            right: { literal: target },
          },
          steps: [leaf("poll")],
        },
        leaf("tail"),
      ],
    });
    const plans = [
      await call(`projects/${p.id}/plans`, input(2)),
      await call(`projects/${p.id}/plans`, input(99)),
    ];
    const inspect = (run, early) => {
      assert.equal(run.status, early ? "passed" : "failed");
      assert.deepEqual(
        run.results.map((r) => r.stepId),
        early
          ? ["setup", "poll", "poll", "tail"]
          : ["setup", "poll", "poll", "poll"],
      );
      assert.deepEqual(
        run.conditionResults.map((r) => r.matched),
        early ? [false, true] : [false, false, false],
      );
      assert.ok(
        run.conditionResults.every(
          (r) => r.kind === "repeat-until" && r.phase === "after",
        ),
      );
      if (!early) {
        assert.equal(run.stopReason, "repeat-condition-exhausted");
        assert.equal(run.untilLimit.completedIterations, 3);
        assert.equal(run.untilLimit.groupId, "loop");
      }
    };
    const checkWire = (start, early) =>
      assert.deepEqual(
        seen.slice(start),
        early
          ? ["/setup", "/poll", "/poll", "/tail"]
          : ["/setup", "/poll", "/poll", "/poll"],
      );
    for (let i = 0; i < 2; i++) {
      const start = seen.length;
      inspect(
        await call(`projects/${p.id}/run`, { planId: plans[i].id }),
        i === 0,
      );
      checkWire(start, i === 0);
    }
    const config = await call("mcp/config", {
      enabled: true,
      projects: [p.id],
      write: true,
      execute: true,
      remember: false,
    });
    for (const mode of ["http", "stdio"]) {
      const c = new Client({ name: "until-test", version: "1" });
      clients.push(c);
      await c.connect(
        mode === "http"
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
      const tool = async (name, args) => {
        const r = await c.callTool({ name, arguments: args });
        assert.notEqual(r.isError, true, r.content?.[0]?.text);
        return JSON.parse(r.content[0].text);
      };
      for (let i = 0; i < 2; i++) {
        const start = seen.length;
        const run = await tool("localapi_run_plan", {
          projectId: p.id,
          planId: plans[i].id,
        });
        inspect(run, i === 0);
        checkWire(start, i === 0);
        const list = await tool("localapi_list_plans", { projectId: p.id });
        const summary = list.runs.find((r) => r.id === run.id);
        assert.equal(summary.status, run.status);
        assert.equal(summary.conditionCount, i === 0 ? 2 : 3);
        if (i === 1) {
          assert.equal(summary.stopReason, "repeat-condition-exhausted");
          assert.equal(summary.untilLimit.completedIterations, 3);
        }
        assert.equal(Object.hasOwn(summary, "conditionResults"), false);
      }
      const denied = await c.callTool({
        name: "localapi_list_plans",
        arguments: { projectId: other.id },
      });
      assert.equal(denied.isError, true);
      await c.close();
    }
    const backup = await call(`projects/${p.id}/export`);
    const beforeRestore = seen.length;
    const restored = await call("restore", { document: backup }, 201);
    assert.deepEqual(restored.plans, backup.plans);
    assert.deepEqual(restored.runs, backup.runs);
    await close(app);
    app = await createApp({ root, port: 0 });
    assert.equal(seen.length, beforeRestore);
    for (const run of (await app.store.get(restored.id)).runs)
      inspect(run, run.status === "passed");
    for (let i = 0; i < 2; i++) {
      const start = seen.length;
      let output;
      try {
        output = await promisify(execFile)(
          process.execPath,
          [
            repo + "/scripts/run-plan.mjs",
            "--project",
            restored.id,
            "--plan",
            plans[i].id,
          ],
          {
            cwd: repo,
            env: { ...process.env, LOCAL_API_DATA: root },
            timeout: 10000,
            maxBuffer: 4 * 1024 * 1024,
          },
        );
      } catch (error) {
        assert.equal(i, 1);
        assert.equal(error.code, 1);
        output = error;
      }
      const run = JSON.parse(output.stdout);
      inspect(run, i === 0);
      assert.equal(run.recordSaved, true);
      checkWire(start, i === 0);
    }
    const beforeStaged = await app.store.get(restored.id);
    for (let i = 0; i < 2; i++) {
      const start = seen.length;
      const r = await fetch(
        app.url + `/api/projects/${restored.id}/staged-load`,
        {
          method: "POST",
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            planId: plans[i].id,
            schedule: {
              initialVUs: 1,
              stages: [{ durationSeconds: 3, targetVUs: 1 }],
              maxIterations: 2,
            },
          }),
        },
      );
      const text = await r.text();
      assert.equal(r.status, 200, text);
      const events = text
        .trim()
        .split("\n\n")
        .map((e) => {
          const [name, data] = e.split("\n");
          return { name: name.slice(7), value: JSON.parse(data.slice(6)) };
        });
      assert.equal(events.at(-1).name, "complete");
      assert.equal(events.at(-1).value.stopReason, "iteration-limit");
      const report = events.at(-2).value;
      assert.equal(report.mainRequests, 8);
      assert.deepEqual(
        seen.slice(start),
        Array.from({ length: 2 }, () =>
          i === 0
            ? ["/setup", "/poll", "/poll", "/tail"]
            : ["/setup", "/poll", "/poll", "/poll"],
        ).flat(),
      );
      assert.equal(report.completed, 2);
      assert.equal(report.failed, i === 0 ? 0 : 2);
      assert.deepEqual(
        report.steps.map((x) => [x.stepId, x.count, x.failed]),
        i === 0
          ? [
              ["setup", 2, 0],
              ["poll", 4, 0],
              ["tail", 2, 0],
            ]
          : [
              ["setup", 2, 0],
              ["poll", 6, 0],
              ["tail", 0, 0],
            ],
      );
    }
    assert.deepEqual(await app.store.get(restored.id), beforeStaged);
    assert.deepEqual(await app.store.get(other.id), otherBefore);
    const beforeInvalid = await app.store.get(p.id);
    const count = seen.length;
    const bad = input(2);
    bad.steps[1].rows = [{}, {}, {}];
    await call(`projects/${p.id}/plans`, bad, 400);
    assert.equal(seen.length, count);
    assert.deepEqual(await app.store.get(p.id), beforeInvalid);
    const unknownInput = {
      name: "unknown commit dominates until",
      steps: [
        {
          type: "repeat",
          id: "unknown-loop",
          count: 3,
          untilCondition: {
            op: "eq",
            left: { literal: true },
            right: { literal: true },
          },
          steps: [
            {
              id: "effect",
              request: {
                url: url + "/poll",
                extract: [
                  {
                    name: "durableN",
                    source: "json",
                    path: "$.n",
                    scope: "environment",
                  },
                ],
              },
            },
          ],
        },
        leaf("tail"),
      ],
    };
    const unknownPlan = await call(`projects/${p.id}/plans`, unknownInput);
    const store = app.store,
      save = store.save,
      read = store.readUnlocked;
    const directory = store.directory(p.id),
      history = join(directory, "history"),
      kept = join(directory, "owned-history-backup");
    let attempts = 0,
      journal;
    store.save = async function (project, options) {
      if (project.id !== p.id || options?.activity || attempts)
        return save.call(this, project, options);
      attempts++;
      this.readUnlocked = async function (id) {
        const state = await read.call(this, id);
        this.readUnlocked = read;
        await rename(history, kept);
        await writeFile(history, "owned-test-obstacle");
        return state;
      };
      try {
        return await save.call(this, project, options);
      } finally {
        this.readUnlocked = read;
        journal = JSON.parse(
          await readFile(join(directory, ".transaction.json"), "utf8"),
        );
        await rm(history);
        await rename(kept, history);
      }
    };
    const beforeUnknown = seen.length;
    let unknown;
    try {
      unknown = await call(`projects/${p.id}/run`, { planId: unknownPlan.id });
    } finally {
      store.save = save;
      store.readUnlocked = read;
    }
    assert.equal(attempts, 1);
    assert.ok(journal);
    assert.equal(unknown.status, "failed");
    assert.equal(unknown.stopReason, "scope-commit-unknown");
    assert.deepEqual(unknown.conditionResults, []);
    assert.equal(unknown.results.length, 1);
    assert.equal(unknown.results[0].response.status, 200);
    assert.deepEqual(unknown.results[0].scopeCommit, {
      outcome: "unknown",
      retrySafe: false,
    });
    assert.equal(unknown.recordSaved, true);
    assert.deepEqual(seen.slice(beforeUnknown), ["/poll"]);
    await close(app);
    app = await createApp({ root, port: 0 });
    const recovered = await app.store.get(p.id);
    const record = recovered.runs.find((r) => r.id === unknown.id);
    assert.deepEqual(record.results, unknown.results);
    assert.equal(record.stopReason, "scope-commit-unknown");
    assert.equal(recovered.environments[0].variables.durableN, n);
    assert.deepEqual(seen.slice(beforeUnknown), ["/poll"]);
    assert.deepEqual(await app.store.get(other.id), otherBefore);
  },
);
