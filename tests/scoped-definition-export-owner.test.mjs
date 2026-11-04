import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { importIntoProject, normalizeRequest } from "../src/core.mjs";

async function fixture(t) {
  let sends = 0;
  const wire = http.createServer((_req, res) => {
    sends++;
    res.end("unexpected execution");
  });
  await new Promise((resolve) => wire.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(path.join(tmpdir(), "scoped-export-owner-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    wire.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => app.server.close(resolve)),
      new Promise((resolve) => wire.close(resolve)),
    ]);
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("Scoped export source");
  project.folders = ["A", "A/B", "Unselected"];
  project.requests = [
    normalizeRequest({
      id: "chosen",
      name: "Chosen",
      folder: "A/B",
      url: `http://127.0.0.1:${wire.address().port}/chosen`,
      auth: { type: "basic", username: "fixture", password: "scope-secret" },
    }),
    normalizeRequest({
      id: "other",
      name: "Other",
      folder: "Unselected",
      url: `http://127.0.0.1:${wire.address().port}/other`,
    }),
  ];
  await app.store.save(project);
  const peer = await app.store.create("Unchanged peer");
  const base = app.url + "/api/projects/" + project.id;
  const headers = {
    "x-local-token": app.token,
    "content-type": "application/json",
  };
  const post = async (action, input) => {
    const response = await fetch(base + "/" + action, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    return { status: response.status, body: await response.json() };
  };
  return { root, app, project, peer, base, headers, post, sends: () => sends };
}

for (const format of ["apipost", "apipost-directory"])
  test(`owner scoped ${format} preview/export preserves selected ancestry and remains read-only`, async (t) => {
    const f = await fixture(t);
    const before = await f.app.store.get(f.project.id);
    const peerBefore = await f.app.store.get(f.peer.id);
    const input = {
      format,
      selection: {
        mode: "explicit",
        resources: [{ kind: "api", id: "chosen" }],
      },
    };
    const preview = await f.post("export-preview", input);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.projectId, f.project.id);
    assert.equal(preview.body.configRevision, before.configRevision);
    assert.equal(JSON.stringify(preview.body).includes("scope-secret"), false);
    assert.equal(Object.hasOwn(preview.body, "document"), false);
    const exported = await f.post("export-selection", {
      ...input,
      configRevision: preview.body.configRevision,
      scopeDigest: preview.body.scope.digest,
      acceptedDependencies: preview.body.scope.dependencies,
    });
    assert.equal(exported.status, 200, JSON.stringify(exported.body));
    const imported = {
      id: "roundtrip",
      name: "Roundtrip",
      requests: [],
      environments: [],
      plans: [],
      history: [],
      runs: [],
      settings: {},
    };
    importIntoProject(imported, exported.body.document);
    assert.equal(imported.requests.length, 1);
    assert.equal(imported.requests[0].name, "Chosen");
    assert.equal(imported.requests[0].folder, "A/B");
    assert.equal(imported.requests[0].auth.password, "scope-secret");
    assert.equal(imported.requests[0].url, before.requests[0].url);
    assert.deepEqual(await new Store(f.root).get(f.project.id), before);
    assert.deepEqual(await f.app.store.get(f.peer.id), peerBefore);
    assert.equal(f.sends(), 0);
  });

test("owner explicit empty selection refuses rather than exporting a complete secret-bearing project", async (t) => {
  const f = await fixture(t);
  const before = await f.app.store.get(f.project.id);
  const result = await f.post("export-preview", {
    format: "apipost",
    selection: { mode: "explicit", resources: [] },
  });
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.match(result.body.error, /选择|selection/i);
  assert.equal(JSON.stringify(result.body).includes("scope-secret"), false);
  assert.deepEqual(await f.app.store.get(f.project.id), before);
  assert.equal(f.sends(), 0);
});
