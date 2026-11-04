import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";

test(
  "live references freeze all current definitions once per owner run",
  { timeout: 15000 },
  async (t) => {
    const seen = [];
    let startFirst, releaseFirst;
    const started = new Promise((resolve) => {
      startFirst = resolve;
    });
    const gate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let hold = false;
    const peer = createServer(async (req, res) => {
      seen.push(req.url);
      if (hold && req.url === "/first-v2") {
        startFirst();
        await gate;
      }
      res.end("ok");
    });
    await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
    const root = await mkdtemp(join(tmpdir(), "live-plan-"));
    const app = await createApp({ root, port: 0 });
    t.after(async () => {
      releaseFirst();
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
      peer.closeAllConnections();
      await new Promise((resolve) => peer.close(resolve));
      await rm(root, { recursive: true, force: true });
    });
    const project = await app.store.create("live");
    const base = `http://127.0.0.1:${peer.address().port}`;
    project.requests = [
      { id: "first", url: base + "/first-v1" },
      { id: "second", url: base + "/second-v1" },
    ];
    await app.store.save(project);
    const post = async (route, value) => {
      const r = await fetch(app.url + "/api/" + route, {
        method: "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: JSON.stringify(value),
      });
      return { status: r.status, body: await r.json() };
    };
    const step = (id) => ({
      id: "step-" + id,
      liveRequestId: id,
      request: {
        id,
        url: base + "/" + id + "-v1",
        beforeScript: "pm.environment.set('planTask','kept');",
      },
    });
    const created = await post(`projects/${project.id}/plans`, {
      name: "live",
      steps: [step("first"), step("second")],
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const planId = created.body.id;
    const edit = await app.store.get(project.id);
    edit.requests[0].url = base + "/first-v2";
    edit.requests[0].beforeScript = "throw Error('API script must not run')";
    edit.requests[1].url = base + "/second-v2";
    await app.store.save(edit);
    hold = true;
    const pending = post(`projects/${project.id}/run`, { planId });
    await started;
    const during = await app.store.get(project.id);
    during.requests[1].url = base + "/second-v3";
    await app.store.save(during);
    releaseFirst();
    const first = await pending;
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.status, "passed", JSON.stringify(first.body));
    assert.deepEqual(seen, ["/first-v2", "/second-v2"]);
    assert.deepEqual(first.body.liveBindings, [
      { stepId: "step-first", requestId: "first" },
      { stepId: "step-second", requestId: "second" },
    ]);
    assert(!JSON.stringify(first.body.snapshot).includes("liveRequestId"));
    hold = false;
    const second = await post(`projects/${project.id}/run`, { planId });
    assert.equal(second.body.status, "passed");
    assert.deepEqual(seen.slice(-2), ["/first-v2", "/second-v3"]);
    const broken = await app.store.get(project.id);
    broken.requests[1].deletedAt = "2026-01-01T00:00:00Z";
    await app.store.save(broken);
    const before = seen.length;
    const rejected = await post(`projects/${project.id}/run`, { planId });
    assert.equal(rejected.status, 400);
    assert.equal(seen.length, before);
  },
);

test(
  "official MCP SDK, CLI and restored project materialize the same project-local reference",
  { timeout: 20000 },
  async (t) => {
    const { Client } = await import(
      "@modelcontextprotocol/sdk/client/index.js"
    );
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const seen = [];
    const peer = createServer((req, res) => {
      seen.push(req.url);
      res.end("ok");
    });
    await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
    const root = await mkdtemp(join(tmpdir(), "live-plan-entrypoints-"));
    const app = await createApp({ root, port: 0 });
    const sdk = new Client({ name: "live-plan-test", version: "1" });
    t.after(async () => {
      await sdk.close().catch(() => {});
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
      peer.closeAllConnections();
      await new Promise((resolve) => peer.close(resolve));
      await rm(root, { recursive: true, force: true });
    });
    const p = await app.store.create("live");
    const url = `http://127.0.0.1:${peer.address().port}`;
    p.requests = [{ id: "api", url: url + "/latest" }];
    await app.store.save(p);
    const post = async (route, body) => {
      const r = await fetch(app.url + "/api/" + route, {
        method: "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      assert.equal(r.status, 200, JSON.stringify(data));
      return data;
    };
    const plan = await post(`projects/${p.id}/plans`, {
      steps: [
        {
          id: "s",
          liveRequestId: "api",
          request: { id: "api", url: url + "/old" },
        },
      ],
    });
    const settings = await post("mcp/config", {
      enabled: true,
      projects: [p.id],
      write: true,
      execute: true,
      remember: false,
    });
    await sdk.connect(
      new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + settings.token } },
      }),
    );
    const sdkResponse = await sdk.callTool({
      name: "localapi_run_plan",
      arguments: { projectId: p.id, planId: plan.id },
    });
    assert.notEqual(sdkResponse.isError, true, sdkResponse.content?.[0]?.text);
    const sdkRun = JSON.parse(sdkResponse.content[0].text);
    assert.equal(sdkRun.status, "passed");
    assert.equal(sdkRun.liveBindings[0].requestId, "api");
    const cli = await promisify(execFile)(
      process.execPath,
      ["scripts/run-plan.mjs", "--project", p.id, "--plan", plan.id],
      {
        cwd: process.cwd(),
        env: { ...process.env, LOCAL_API_DATA: root },
        timeout: 10000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const cliRun = JSON.parse(cli.stdout);
    assert.equal(cliRun.status, "passed");
    assert.equal(cliRun.planHash, sdkRun.planHash);
    const restored = await app.store.restore(await app.store.get(p.id));
    assert.equal(restored.plans[0].steps[0].liveRequestId, "api");
    const again = await post(`projects/${restored.id}/run`, {
      planId: plan.id,
    });
    assert.equal(again.status, "passed");
    assert.deepEqual(seen, ["/latest", "/latest", "/latest"]);
  },
);

test(
  "cancel during live snapshot refresh prevents every request and releases run ID",
  { timeout: 10000 },
  async (t) => {
    const { versionPlan } = await import("../src/plan-version.mjs");
    let hits = 0,
      entered,
      release;
    const waiting = new Promise((resolve) => {
      entered = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const peer = createServer((_req, res) => {
      hits++;
      res.end("ok");
    });
    await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
    const root = await mkdtemp(join(tmpdir(), "live-preflight-cancel-"));
    const app = await createApp({ root, port: 0 });
    const original = app.store.get.bind(app.store);
    t.after(async () => {
      app.store.get = original;
      release();
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
      peer.closeAllConnections();
      await new Promise((resolve) => peer.close(resolve));
      await rm(root, { recursive: true, force: true });
    });
    const p = await app.store.create("cancel");
    const url = `http://127.0.0.1:${peer.address().port}/`;
    p.requests = [{ id: "api", url }];
    p.plans.push(
      versionPlan(
        undefined,
        {
          id: "p1",
          steps: [
            { id: "s", liveRequestId: "api", request: { id: "api", url } },
          ],
        },
        "manual",
        p,
      ),
    );
    await app.store.save(p);
    let reads = 0;
    app.store.get = async (...args) => {
      reads++;
      if (reads === 2) {
        entered();
        await gate;
      }
      return original(...args);
    };
    const headers = {
      "x-local-token": app.token,
      "content-type": "application/json",
    };
    const pending = fetch(`${app.url}/api/projects/${p.id}/run`, {
      method: "POST",
      headers,
      body: JSON.stringify({ planId: "p1", runId: "live-cancel" }),
    });
    await waiting;
    const cancel = await fetch(`${app.url}/api/cancel`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "live-cancel" }),
    });
    assert.equal(cancel.status, 200);
    release();
    const response = await pending;
    assert.equal(response.status, 400);
    assert.equal(hits, 0);
    app.store.get = original;
    const again = await fetch(`${app.url}/api/projects/${p.id}/run`, {
      method: "POST",
      headers,
      body: JSON.stringify({ planId: "p1", runId: "live-cancel" }),
    });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).status, "passed");
    assert.equal(hits, 1);
  },
);
