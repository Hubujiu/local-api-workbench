import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exportApipost } from "../src/apipost-export.mjs";
import {
  normalizeRequest,
  importIntoProject,
  restoreProject,
  interpolate,
} from "../src/core.mjs";
import { Store, executeRequest } from "../src/runtime.mjs";
import { environmentVariables } from "../src/environments.mjs";

test("native JSON definition export reimports, persists and restores literal HTTP and environment values without mutation", async (t) => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    seen.push({
      method: req.method,
      url: req.url,
      body,
      auth: req.headers.authorization,
      header: req.headers["x-value"],
    });
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const root = await mkdtemp(path.join(os.tmpdir(), "native-export-"));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const store = new Store(root),
    p = await store.create("Fictional native export");
  p.environments[0].variables.value = "current";
  p.environments[0].variableDefinitions = {
    value: { initialValue: "initial", description: "preserved" },
  };
  p.folders = ["A", "A/B"];
  p.requests = [
    normalizeRequest({
      id: "source",
      name: "Echo",
      folder: "A/B",
      method: "POST",
      url: `http://127.0.0.1:${server.address().port}/echo?literal=%2f`,
      query: [
        { key: "q", value: "one" },
        { key: "q", value: "two" },
        { key: "skip", value: "disabled", enabled: false },
      ],
      headers: [{ key: "X-Value", value: "{{value}}" }],
      bodyType: "json",
      body: '{"value":"{{value}}"}',
      auth: { type: "basic", username: "fixture", password: "fictional" },
    }),
  ];
  const before = structuredClone(p),
    document = exportApipost(p);
  assert.deepEqual(p, before);
  assert.deepEqual(exportApipost(p), document);
  const target = await store.create("Imported");
  target.environments = [];
  importIntoProject(target, JSON.stringify(document));
  await store.save(target);
  const saved = await store.get(target.id),
    restored = restoreProject(saved);
  await store.save(restored);
  for (const copy of [saved, await store.get(restored.id)]) {
    assert.equal(copy.requests[0].folder, "A/B");
    assert.equal(
      copy.environments[0].variableDefinitions.value.initialValue,
      "initial",
    );
    const r = interpolate(
      copy.requests[0],
      environmentVariables(copy, copy.environments[0].id),
    );
    assert.equal((await executeRequest(r)).status, 200);
  }
  assert.deepEqual(
    seen,
    Array(2).fill({
      method: "POST",
      url: "/echo?literal=%2f&q=one&q=two",
      body: '{"value":"current"}',
      auth: "Basic Zml4dHVyZTpmaWN0aW9uYWw=",
      header: "current",
    }),
  );
  assert.notEqual(restored.id, target.id);
  assert.deepEqual(p, before);
});

test("unsupported native export dependencies reject rather than create silently partial definitions", () => {
  const base = {
    id: "p",
    name: "P",
    requests: [normalizeRequest({ id: "r", url: "http://127.0.0.1/a" })],
    environments: [],
    settings: {},
  };
  for (const change of [
    (p) => (p.plans = [{ id: "plan" }]),
    (p) => (p.protocols = [{ id: "ws" }]),
    (p) => (p.settings.globalScripts = { beforeScript: "danger()" }),
    (p) => (p.requests[0].bodyDynamic = { a: { source: "x" } }),
    (p) => (p.requests[0].auth = { type: "hawk" }),
    (p) => (p.requests[0].timeout = 1000),
    (p) => (p.requests[0].beforeScript = "danger()"),
    (p) => (p.requests[0].examples = [{ status: 200, body: "x" }]),
    (p) => p.requests.push(p.requests[0]),
  ]) {
    const p = structuredClone(base);
    change(p);
    const snapshot = structuredClone(p);
    assert.throws(() => exportApipost(p));
    assert.deepEqual(p, snapshot);
  }
});
