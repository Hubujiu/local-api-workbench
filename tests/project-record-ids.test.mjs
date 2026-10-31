import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Store } from "../src/runtime.mjs";
import { restoreProject, normalizeRequest } from "../src/core.mjs";

test("unrepresentable record IDs reject before journaling without changing persisted state", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "record-ids-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root),
    original = await store.create("preserve");
  const before = await store.get(original.id);
  for (const ids of [
    ["\ud800", "\ud801"],
    ["a".repeat(154)],
    ["中".repeat(100)],
    [
      "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    ],
    ["\0", "h"],
  ]) {
    const p = structuredClone(before);
    p.environments = ids.map((id, i) => ({
      id,
      name: "env-" + i,
      variables: { value: i },
    }));
    await assert.rejects(store.save(p), (error) => {
      assert.notEqual(error.code, "PROJECT_COMMIT_UNCERTAIN");
      assert.match(error.message, /记录ID/);
      return true;
    });
    assert.deepEqual(await new Store(root).get(original.id), before);
    await assert.rejects(
      readFile(path.join(store.directory(original.id), ".transaction.json")),
      { code: "ENOENT" },
    );
  }
  const restored = restoreProject({
    ...before,
    requests: [
      normalizeRequest({
        id: "a".repeat(154),
        name: "too long",
        url: "http://127.0.0.1/",
      }),
    ],
  });
  await assert.rejects(store.save(restored), /记录ID/);
  await assert.rejects(
    readFile(path.join(store.directory(restored.id), ".transaction.json")),
    { code: "ENOENT" },
  );
  assert.deepEqual(await store.get(original.id), before);
});

test("maximum safe encoded component and distinct valid Unicode IDs roundtrip on disk", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "record-ids-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root),
    p = await store.create("boundary");
  const ids = ["a".repeat(153), "中文", "😀"];
  p.environments = ids.map((id, i) => ({
    id,
    name: "env-" + i,
    variables: { value: i },
  }));
  await store.save(p);
  const saved = await new Store(root).get(p.id);
  assert.deepEqual(saved.environments, p.environments);
  const restored = restoreProject(saved);
  await store.save(restored);
  assert.deepEqual(
    (await new Store(root).get(restored.id)).environments,
    p.environments,
  );
  await assert.rejects(
    readFile(path.join(store.directory(p.id), ".transaction.json")),
    { code: "ENOENT" },
  );
});

test("HTTP restore rejects unsafe ID layouts without publishing a new project", async (t) => {
  const { createApp } = await import("../src/server.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "record-ids-http-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("before");
  const headers = {
    "x-local-token": app.token,
    "content-type": "application/json",
  };
  const before = await app.store.list();
  for (const ids of [["\ud800", "\ud801"], ["a".repeat(154)]]) {
    const document = structuredClone(p);
    document.environments = ids.map((id, i) => ({
      id,
      name: "env-" + i,
      variables: {},
    }));
    const response = await fetch(app.url + "/api/restore", {
      method: "POST",
      headers,
      body: JSON.stringify({ document }),
    });
    assert.equal(response.status, 400);
    const result = await response.json();
    assert.match(result.error, /记录ID/);
    assert.notEqual(result.code, "PROJECT_COMMIT_UNCERTAIN");
    assert.deepEqual(await app.store.list(), before);
    assert.deepEqual(await app.store.get(p.id), p);
  }
});
