import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { createMCP } from "../src/mcp.mjs";
import { Store } from "../src/runtime.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "plan-environment-evidence-"));
  let app = await createApp({ root, port: 0 });
  const seen = [];
  const peer = http.createServer((q, r) => {
    seen.push(q.headers["x-env"]);
    r.writeHead(q.url === "/fail" ? 500 : 200);
    r.end("same response");
  });
  await new Promise((r) => peer.listen(0, "127.0.0.1", r));
  const stop = async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
  };
  t.after(async () => {
    await stop();
    peer.closeAllConnections();
    await new Promise((r) => peer.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const post = async (route, body, status = 200) => {
    const r = await fetch(app.url + route, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      body: JSON.stringify(body),
    });
    const v = await r.json();
    assert.equal(r.status, status, JSON.stringify(v));
    return v;
  };
  const p = await app.store.create("environment proof");
  p.environments = [
    { id: "A", name: "Env A", variables: { same: "value" } },
    { id: "B", name: "Env B", variables: { same: "value" } },
  ];
  p.currentEnvironmentId = "B";
  await app.store.save(p);
  const other = await app.store.create("untouched"),
    untouched = await app.store.get(other.id);
  const request = (suffix = "ok") => ({
    url: `http://127.0.0.1:${peer.address().port}/${suffix}`,
    scriptDialect: "apipost8",
    beforeScript: 'apt.setRequestHeader("x-env",pm.environment.getName());',
  });
  const cli = (projectId, planId, environment) =>
    new Promise((resolve, reject) => {
      const args = [
        "scripts/run-plan.mjs",
        "--project",
        projectId,
        "--plan",
        planId,
      ];
      if (environment !== undefined) args.push("--environment", environment);
      const child = spawn(process.execPath, args, {
        cwd: path.resolve(import.meta.dirname, ".."),
        env: { ...process.env, LOCAL_API_DATA: root },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (x) => (stdout += x));
      child.stderr.on("data", (x) => (stderr += x));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  return {
    root,
    p,
    other,
    untouched,
    seen,
    post,
    request,
    cli,
    get store() {
      return app.store;
    },
    async restart() {
      await stop();
      app = await createApp({ root, port: 0 });
    },
  };
}
for (const entry of ["owner", "cli"])
  test(`${entry} plan evidence records actual environment without rewriting frozen default across persistence and restart`, async (t) => {
    const f = await fixture(t);
    for (const [defaultEnv, override, status] of [
      ["A", "B", "ok"],
      ["A", undefined, "fail"],
      ["", undefined, "ok"],
    ]) {
      const plan = await f.post(`/api/projects/${f.p.id}/plans`, {
        environmentId: defaultEnv,
        statusPolicy: "strict200",
        steps: [{ request: f.request(status) }],
      });
      const expected = override || defaultEnv || "B";
      const execute = async (projectId) => {
        if (entry === "owner")
          return f.post(`/api/projects/${projectId}/run`, {
            planId: plan.id,
            ...(override === undefined ? {} : { environmentId: override }),
          });
        const r = await f.cli(projectId, plan.id, override);
        assert.equal(r.code, status === "fail" ? 1 : 0, r.stderr);
        return JSON.parse(r.stdout);
      };
      let count = f.seen.length;
      const result = await execute(f.p.id);
      assert.equal(f.seen.length, count + 1);
      assert.equal(f.seen.at(-1), "Env " + expected);
      assert.equal(result.environmentId, expected);
      assert.equal(result.snapshot.environmentId, defaultEnv);
      assert.equal(result.status, status === "fail" ? "failed" : "passed");
      assert.equal(result.recordSaved, true);
      const disk = await new Store(f.root).get(f.p.id);
      assert.equal(
        disk.runs.find((r) => r.id === result.id).environmentId,
        expected,
      );
      assert.equal(
        disk.plans.find((p) => p.id === plan.id).environmentId,
        defaultEnv,
      );
      const restored = await f.post("/api/restore", { document: disk }, 201);
      assert.equal(
        restored.runs.find((r) => r.id === result.id).environmentId,
        expected,
      );
      await f.restart();
      count = f.seen.length;
      const again = await execute(restored.id);
      assert.equal(f.seen.length, count + 1);
      assert.equal(again.environmentId, expected);
      assert.equal(again.snapshot.environmentId, defaultEnv);
    }
    const plan = await f.post(`/api/projects/${f.p.id}/plans`, {
      environmentId: "A",
      steps: [{ request: f.request() }],
    });
    const count = f.seen.length;
    if (entry === "owner")
      await f.post(
        `/api/projects/${f.p.id}/run`,
        { planId: plan.id, environmentId: "absent" },
        400,
      );
    else {
      const r = await f.cli(f.p.id, plan.id, "absent");
      assert.equal(r.code, 2);
      assert.match(r.stderr, /环境不存在/);
    }
    assert.equal(f.seen.length, count);
    assert.deepEqual(await f.store.get(f.other.id), f.untouched);
  });
test("MCP retains existing actual environment identity and old records remain unguessed", async (t) => {
  const f = await fixture(t);
  const plan = await f.post(`/api/projects/${f.p.id}/plans`, {
    environmentId: "A",
    steps: [{ request: f.request() }],
  });
  const mcp = createMCP({
    store: f.store,
    projects: [f.p.id],
    write: true,
    execute: true,
  });
  const r = await mcp({
    id: 1,
    method: "tools/call",
    params: {
      name: "localapi_execute_flow",
      arguments: { projectId: f.p.id, planId: plan.id, environmentId: "B" },
    },
  });
  assert.notEqual(r.result.isError, true, JSON.stringify(r));
  const result = JSON.parse(r.result.content[0].text);
  assert.equal(result.environmentId, "B");
  assert.equal(result.snapshot.environmentId, "A");
  assert.equal(f.seen.at(-1), "Env B");
  const disk = await new Store(f.root).get(f.p.id);
  delete disk.runs[0].environmentId;
  const restored = await f.post("/api/restore", { document: disk }, 201);
  assert.equal(Object.hasOwn(restored.runs[0], "environmentId"), false);
});
