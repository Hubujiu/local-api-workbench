import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { normalizeRequest } from "../src/core.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";

// Deliberate real-owner REDs before route implementation. Missing locked
// dependencies are module-load blockers, not executed application scenarios.
async function snapshot(directory) {
  const out = {};
  async function visit(at, prefix = "") {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory())
        await visit(path.join(at, entry.name), name + "/");
      else if (!name.endsWith(".lock") && !/\.lock[-.]/.test(name))
        out[name] = (await readFile(path.join(at, entry.name))).toString(
          "base64",
        );
    }
  }
  await visit(directory);
  return out;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "manual-import-workflow-"));
  const app = await createApp({ root, port: 0 });
  let hits = 0;
  const peer = http.createServer((_req, res) => {
    hits++;
    res.end("must not run during import");
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    app.server.closeAllConnections();
    peer.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => app.server.close(resolve)),
      new Promise((resolve) => peer.close(resolve)),
    ]);
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("Manual resource plan fixture");
  const untouched = await app.store.create("Untouched project");
  const document = modernApipostFixture();
  document.global.envs[0].server_list[0].uri = `http://127.0.0.1:${peer.address().port}`;
  document.global.global_vars.shared.current_value = "private-source-value";
  const input = {
    format: "apipost",
    document,
    selection: { mode: "all" },
    policies: { api: "both" },
  };
  async function post(action, body, authenticated = true) {
    const response = await fetch(
      `${app.url}/api/projects/${project.id}/${action}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authenticated ? { "x-local-token": app.token } : {}),
        },
        body: JSON.stringify(body),
      },
    );
    return { status: response.status, data: await response.json() };
  }
  return { root, app, project, untouched, input, post, hits: () => hits };
}

test("owner previews without persistence, atomically applies all supported metadata, then reopens and restores a backup", async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.root);
  const preview = await f.post("import-preview", f.input);
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.version, 1);
  assert.equal(preview.data.configRevision, f.project.configRevision);
  assert.equal(preview.data.blockers.length, 0);
  assert.equal(typeof preview.data.token, "string");
  assert.ok(preview.data.items.some((item) => item.kind === "api"));
  assert.equal(
    JSON.stringify(preview.data).includes("private-source-value"),
    false,
  );
  assert.deepEqual(await snapshot(f.root), before);
  const apply = await f.post("import-apply", {
    token: preview.data.token,
    input: f.input,
  });
  assert.equal(apply.status, 200, JSON.stringify(apply.data));
  assert.equal(apply.data.configRevision, f.project.configRevision + 1);
  const saved = await new Store(f.root).get(f.project.id);
  assert.equal(saved.requests.length, 1);
  assert.equal(saved.globalVariables.shared, "private-source-value");
  assert.ok(saved.settings.statuses.length);
  assert.ok(saved.requestDefinitionHistory.entries.length);
  assert.equal(saved.history.length, 0);
  assert.equal(f.hits(), 0);
  assert.deepEqual(await f.app.store.get(f.untouched.id), f.untouched);
  const restored = await f.app.store.restore(saved);
  assert.notEqual(restored.id, saved.id);
  assert.equal(restored.requests[0].id, saved.requests[0].id);
  assert.equal(restored.globalVariables.shared, saved.globalVariables.shared);
  assert.equal(f.hits(), 0);
  const repeated = await f.post("import-apply", {
    token: preview.data.token,
    input: f.input,
  });
  assert.notEqual(repeated.status, 200);
  assert.equal((await f.app.store.get(saved.id)).requests.length, 1);
});

test("explicit empty selection is a genuine no-op and clear cannot turn empty selection into deletion", async (t) => {
  const f = await fixture(t);
  f.input.selection = { mode: "explicit", keys: [] };
  const before = await snapshot(f.root);
  const preview = await f.post("import-preview", f.input);
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.noOp, true);
  const result = await f.post("import-apply", {
    token: preview.data.token,
    input: f.input,
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.noOp, true);
  assert.equal(result.data.configRevision, f.project.configRevision);
  assert.deepEqual(await snapshot(f.root), before);
  f.input.policies.api = "clear";
  f.input.clearScope = { folder: "" };
  assert.notEqual((await f.post("import-preview", f.input)).status, 200);
  assert.deepEqual(await snapshot(f.root), before);
});

test("owner cannot apply a changed source, selection, token or stale configuration, and neither route bypasses authorization", async (t) => {
  const f = await fixture(t);
  for (const action of ["import-preview", "import-apply"])
    assert.equal((await f.post(action, f.input, false)).status, 403);
  const preview = await f.post("import-preview", f.input);
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  const before = await snapshot(f.root);
  for (const change of [
    (body) => (body.input.document.apis[1].name = "changed source"),
    (body) => (body.input.selection = { mode: "explicit", keys: [] }),
    (body) => (body.input.policies.api = "ignore"),
    (body) => (body.token += "x"),
    (body) => (body.sessionId = "client-chosen-identity"),
  ]) {
    const body = structuredClone({ token: preview.data.token, input: f.input });
    change(body);
    assert.notEqual((await f.post("import-apply", body)).status, 200);
    assert.deepEqual(await snapshot(f.root), before);
  }
  const current = await f.app.store.get(f.project.id);
  current.name = "Concurrent configuration";
  await f.app.store.save(current);
  const concurrent = await snapshot(f.root);
  assert.notEqual(
    (
      await f.post("import-apply", {
        token: preview.data.token,
        input: f.input,
      })
    ).status,
    200,
  );
  assert.deepEqual(await snapshot(f.root), concurrent);
  assert.equal(f.hits(), 0);
});

test("clear is a recoverable scoped leaf replacement, not a destructive folder or sibling operation", async (t) => {
  const f = await fixture(t);
  const p = await f.app.store.get(f.project.id);
  p.folders = ["Group", "GroupSibling"];
  p.requests = [
    normalizeRequest({
      id: "old",
      name: "Old",
      url: "https://example.invalid/old",
      folder: "Group",
    }),
    normalizeRequest({
      id: "sibling",
      name: "Sibling",
      url: "https://example.invalid/sibling",
      folder: "GroupSibling",
    }),
  ];
  await f.app.store.save(p);
  f.input.policies.api = "clear";
  f.input.clearScope = { folder: "Group" };
  const preview = await f.post("import-preview", f.input);
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.blockers.length, 0);
  assert.ok(
    preview.data.items.some(
      (item) => item.action === "trash" && item.targetId === "old",
    ),
  );
  assert.ok(
    !preview.data.items.some(
      (item) => item.action === "trash" && item.targetId === "sibling",
    ),
  );
  const applied = await f.post("import-apply", {
    token: preview.data.token,
    input: f.input,
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  const saved = await f.app.store.get(p.id);
  assert.ok(saved.requests.find((request) => request.id === "old").deletedAt);
  assert.deepEqual(
    saved.requests.find((request) => request.id === "sibling"),
    p.requests[1],
  );
  assert.ok(saved.folders.includes("Group"));
  const batch = saved.apiResourceTrash.batches.at(-1);
  assert.deepEqual(batch.selectedTargetIds, ["old"]);
  await f.app.store.restoreAPIResources(saved.id, {
    configRevision: saved.configRevision,
    batchId: batch.id,
  });
  const recovered = await f.app.store.get(saved.id);
  assert.equal(
    recovered.requests.filter((request) => !request.deletedAt).length,
    3,
  );
  assert.equal(f.hits(), 0);
});
