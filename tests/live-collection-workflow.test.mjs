import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";

test(
  "collection live references freeze all current definitions once per owner run",
  { timeout: 15000 },
  async (t) => {
    const seen = [];
    const counters = [];
    const markers = [];
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
      counters.push(req.headers["x-counter"]);
      markers.push(req.headers["x-marker"]);
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
    bind(project);
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
        postmanCollectionId: "a",
        beforeScript:
          "pm.collectionVariables.set('counter', pm.collectionVariables.get('counter') + 1); pm.request.headers.add({key: 'x-counter', value: String(pm.collectionVariables.get('counter'))}); pm.request.headers.add({key: 'x-marker', value: pm.collectionVariables.get('marker')});",
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
    during.postmanCollections.items[0].variables.marker = "new";
    await app.store.save(during);
    releaseFirst();
    const first = await pending;
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.status, "passed", JSON.stringify(first.body));
    assert.deepEqual(seen, ["/first-v2", "/second-v2"]);
    assert.deepEqual(counters, ["1", "2"]);
    assert.deepEqual(markers, ["old", "old"]);
    assert.deepEqual(first.body.liveBindings, [
      { stepId: "step-first", requestId: "first" },
      { stepId: "step-second", requestId: "second" },
    ]);
    assert(!JSON.stringify(first.body.snapshot).includes("liveRequestId"));
    hold = false;
    const second = await post(`projects/${project.id}/run`, { planId });
    assert.equal(second.body.status, "passed");
    assert.deepEqual(seen.slice(-2), ["/first-v2", "/second-v3"]);
    assert.deepEqual(counters.slice(-2), ["3", "4"]);
    assert.deepEqual(markers.slice(-2), ["new", "new"]);
    assert.equal(
      (await app.store.get(project.id)).postmanCollections.items[0].variables
        .counter,
      4,
    );
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
  "collection official MCP SDK, CLI and restored project materialize the same project-local reference",
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
    bind(p);
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
          request: {
            id: "api",
            url: url + "/old",
            postmanCollectionId: "a",
            beforeScript:
              "pm.collectionVariables.set('counter', pm.collectionVariables.get('counter') + 1);",
          },
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

function bind(project) {
  project.postmanCollections = {
    version: 1,
    items: [
      {
        id: "a",
        name: "A",
        variables: { counter: 0, marker: "old" },
        definitions: {
          marker: { initialValue: "old", type: "string", description: "" },
          counter: { initialValue: 0, type: "number", description: "" },
        },
      },
    ],
  };
  project.requests.forEach((request) => {
    request.postmanCollectionId = "a";
  });
}

test(
  "collection live staged iterations isolate writes and mismatches reject before HTTP",
  { timeout: 15000 },
  async (t) => {
    const seen = [];
    const peer = createServer((req, res) => {
      seen.push(req.url);
      res.end("ok");
    });
    await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
    const root = await mkdtemp(join(tmpdir(), "collection-live-staged-"));
    const app = await createApp({ root, port: 0 });
    t.after(async () => {
      app.server.closeAllConnections();
      peer.closeAllConnections();
      await Promise.all([
        new Promise((resolve) => app.server.close(resolve)),
        new Promise((resolve) => peer.close(resolve)),
      ]);
      await rm(root, { recursive: true, force: true });
    });
    const p = await app.store.create("collection live staged");
    const url = `http://127.0.0.1:${peer.address().port}`;
    p.requests = [{ id: "api", url: url + "/{{counter}}" }];
    bind(p);
    p.postmanCollections.items.push({
      ...structuredClone(p.postmanCollections.items[0]),
      id: "b",
    });
    p.plans = [
      {
        id: "plan",
        steps: [
          {
            id: "live",
            liveRequestId: "api",
            request: {
              id: "api",
              url: url + "/old",
              postmanCollectionId: "a",
              beforeScript:
                "pm.expect(pm.collectionVariables.get('counter')).to.equal(0); pm.collectionVariables.set('counter', 1);",
            },
          },
        ],
      },
    ];
    await app.store.save(p);
    const post = async (action, body) =>
      fetch(`${app.url}/api/projects/${p.id}/${action}`, {
        method: "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const response = await post("staged-load", {
      planId: "plan",
      schedule: {
        initialVUs: 2,
        stages: [{ durationSeconds: 1, targetVUs: 2 }],
        maxIterations: 4,
      },
    });
    assert.equal(response.status, 200, await response.clone().text());
    const text = await response.text();
    assert.match(text, /event: reportEnd/);
    assert.deepEqual(seen, ["/1", "/1", "/1", "/1"]);
    assert.equal(
      (await app.store.get(p.id)).postmanCollections.items[0].variables.counter,
      0,
    );
    for (const binding of ["b", undefined]) {
      const changed = await app.store.get(p.id);
      changed.requests[0].postmanCollectionId = binding;
      await app.store.save(changed);
      for (const action of ["run", "staged-load"]) {
        const rejected = await post(action, {
          planId: "plan",
          schedule: {
            initialVUs: 1,
            stages: [{ durationSeconds: 1, targetVUs: 1 }],
            maxIterations: 1,
          },
        });
        assert.equal(rejected.status, 400, await rejected.clone().text());
        assert.match(await rejected.text(), /collection/);
        assert.equal(seen.length, 4);
      }
    }
  },
);

test("mixed live collections and unbound leaves preserve isolation across repeated steps", async (t) => {
  const { runPlan } = await import("../src/core.mjs");
  const { executeRequest } = await import("../src/runtime.mjs");
  const { materializeLivePlan } = await import(
    "../src/live-plan-materialize.mjs"
  );
  const { collectionExecutionScopes } = await import(
    "../src/postman-collection-scopes.mjs"
  );
  const seen = [];
  const peer = createServer((req, res) => {
    seen.push(req.url);
    res.end("ok");
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
  });
  const url = `http://127.0.0.1:${peer.address().port}`;
  const p = {
    requests: [
      { id: "a", url: url + "/a/{{counter}}" },
      { id: "b", url: url + "/b/{{counter}}" },
      { id: "free", url: url + "/free" },
    ],
  };
  bind(p);
  p.postmanCollections.items.push({
    ...structuredClone(p.postmanCollections.items[0]),
    id: "b",
  });
  p.requests[1].postmanCollectionId = "b";
  delete p.requests[2].postmanCollectionId;
  const step = (id, script) => ({
    id,
    liveRequestId: id,
    request: {
      ...p.requests.find((r) => r.id === id),
      url: url + "/old",
      beforeScript: script,
    },
  });
  const definition = {
    steps: [
      {
        id: "repeat",
        type: "repeat",
        count: 2,
        steps: [
          step(
            "a",
            "pm.collectionVariables.set('counter', pm.collectionVariables.get('counter')+1);",
          ),
        ],
      },
      step(
        "b",
        "pm.expect(pm.collectionVariables.get('counter')).to.equal(0);",
      ),
      step(
        "free",
        "pm.expect(pm.collectionVariables.toObject()).to.deep.equal({});",
      ),
    ],
  };
  const original = structuredClone(p);
  const frozen = materializeLivePlan(p, definition).plan;
  const run = await runPlan(frozen, {}, executeRequest, {
    collectionScopes: collectionExecutionScopes(p),
  });
  assert.equal(run.status, "passed", JSON.stringify(run));
  assert.deepEqual(seen, ["/a/1", "/a/2", "/b/0", "/free"]);
  assert.deepEqual(p, original);
});
