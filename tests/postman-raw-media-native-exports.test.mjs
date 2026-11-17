// Root-only owner/export contracts. Authored for normal CI; no original runtime.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { normalizeRequest, snapshotPlan } from "../src/core.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";

async function disk(directory) {
  const result = {};
  for (const item of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const file = path.join(directory, item.name);
    result[item.name] = item.isDirectory()
      ? await disk(file)
      : (await readFile(file)).toString("base64");
  }
  return result;
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "raw-native-root-"));
  const seen = [];
  const peer = http.createServer((req, res) => {
    seen.push(req.url);
    res.end("unexpected export network");
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    for (const server of [app.server, peer]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("Raw native export boundary");
  project.environments = [{ id: "env", name: "Environment", variables: {} }];
  const request = normalizeRequest({
    id: "raw",
    name: "Raw",
    method: "POST",
    url: `http://127.0.0.1:${peer.address().port}/inert`,
    bodyType: "raw",
    body: "<literal>中文</literal>",
    headers: [{ key: "Content-Type", value: "application/xml", enabled: true }],
    inheritSharedScripts: false,
    scriptDialect: "apipost8",
  });
  return {
    root,
    app,
    seen,
    project,
    request,
    async call(route, body, expected = 200) {
      const response = await fetch(app.url + "/api/" + route, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10000),
      });
      const value = await response.json();
      assert.equal(response.status, expected, JSON.stringify(value));
      return value;
    },
  };
}
const marked = (request) => ({
  ...request,
  postmanRawBody: { version: 1, language: "xml" },
});

for (const [format, exporter] of [
  ["apipost", exportApipost],
  ["apipost-directory", exportApipostDirectory],
])
  test(`marked raw ${format} owner export refuses semantic loss even with explicit media, backup stays exact`, async (t) => {
    const f = await fixture(t);
    f.project.requests = [f.request];
    await f.app.store.save(f.project);
    // Prove the old unmarked, explicitly typed raw definition is admitted.
    assert.doesNotThrow(() => exporter(f.project));
    await f.call(`projects/${f.project.id}/export?format=${format}`);
    const p = await f.app.store.get(f.project.id);
    p.requests = [marked(f.request)];
    await f.app.store.save(p);
    const before = await f.app.store.get(p.id);
    const bytes = await disk(f.app.store.directory(p.id));
    assert.throws(() => exporter(before), /Postman raw/);
    const rejected = await f.call(
      `projects/${p.id}/export?format=${format}`,
      undefined,
      400,
    );
    assert.match(rejected.error, /Postman raw/);
    assert.equal(JSON.stringify(rejected).includes("<literal>"), false);
    assert.deepEqual(await disk(f.app.store.directory(p.id)), bytes);
    assert.deepEqual(await f.app.store.get(p.id), before);
    const backup = await f.call(`projects/${p.id}/export`);
    assert.deepEqual(backup.requests, before.requests);
    const restored = await f.call("restore", { document: backup }, 201);
    assert.notEqual(restored.id, p.id);
    assert.deepEqual(
      (await new Store(f.root).get(restored.id)).requests,
      before.requests,
    );
    assert.deepEqual(f.seen, []);
  });

test("native directory refuses only frozen marked HTTP state even when the live request is unmarked", async (t) => {
  const f = await fixture(t);
  f.project.requests = [f.request];
  const plan = snapshotPlan({
    id: "plan",
    name: "Frozen",
    statusPolicy: "strict200",
    environmentId: "env",
    steps: [{ id: "step", request: f.request }],
  });
  f.project.plans = [plan];
  await f.app.store.save(f.project);
  assert.doesNotThrow(() => exportApipostDirectory(f.project));
  await f.call(`projects/${f.project.id}/export?format=apipost-directory`);
  const p = await f.app.store.get(f.project.id);
  p.plans[0].steps[0].request = marked(p.plans[0].steps[0].request);
  await f.app.store.save(p);
  const before = await f.app.store.get(p.id);
  const bytes = await disk(f.app.store.directory(p.id));
  const rejected = await f.call(
    `projects/${p.id}/export?format=apipost-directory`,
    undefined,
    400,
  );
  assert.match(rejected.error, /冻结步骤Postman raw/);
  assert.deepEqual(await disk(f.app.store.directory(p.id)), bytes);
  const backup = await f.call(`projects/${p.id}/export`);
  assert.deepEqual(backup.plans, before.plans);
  const restored = await f.call("restore", { document: backup }, 201);
  const reopened = await new Store(f.root).get(restored.id);
  assert.deepEqual(reopened.plans, before.plans);
  assert.equal(reopened.requests[0].postmanRawBody, undefined);
  assert.deepEqual(f.seen, []);
});
