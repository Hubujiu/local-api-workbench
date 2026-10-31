import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Store } from "../src/runtime.mjs";
import { writeProject, readProject } from "../src/project-files.mjs";
import { createApp } from "../src/server.mjs";
import { createMCP } from "../src/mcp.mjs";
const temporary = async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "commit-outcome-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};
test("invalid layout cannot poison a recoverable journal or overwrite existing state", async (t) => {
  const root = await temporary(t),
    store = new Store(root),
    p = await store.create("Before");
  const before = JSON.stringify(await store.get(p.id));
  for (const requests of [
    [{ id: "same" }, { id: "same" }],
    [{ id: "" }],
    [{ id: 42 }],
  ]) {
    await assert.rejects(
      writeProject(store.directory(p.id), { ...p, requests }),
      /记录ID/,
    );
    await assert.rejects(
      readFile(path.join(store.directory(p.id), ".transaction.json")),
      /ENOENT/,
    );
    assert.equal(JSON.stringify(await store.get(p.id)), before);
  }
});
test("failure before journal rename is not reported as a possibly committed write", async (t) => {
  const root = await temporary(t),
    folder = path.join(root, "blocked");
  await writeFile(folder, "fixture");
  await assert.rejects(
    writeProject(folder, { id: "p", requests: [] }),
    (e) => e.code !== "PROJECT_COMMIT_UNCERTAIN",
  );
});
test("real disk layout failure after journaling returns unknown outcome and recovery applies exactly once", async (t) => {
  const root = await temporary(t),
    store = new Store(root),
    p = await store.create("Before");
  const directory = store.directory(p.id),
    apis = path.join(directory, "apis");
  await rm(apis, { recursive: true });
  await writeFile(apis, "fixture blocks directory");
  p.name = "Committed after recovery";
  await assert.rejects(store.save(p), (e) => {
    assert.equal(e.code, "PROJECT_COMMIT_UNCERTAIN");
    assert.equal(e.projectId, p.id);
    assert.equal(e.message.includes(root), false);
    return true;
  });
  const journal = JSON.parse(
    await readFile(path.join(directory, ".transaction.json"), "utf8"),
  );
  assert.equal(journal.name, p.name);
  assert.equal(journal.revision, 2);
  await assert.rejects(store.get(p.id), { code: "PROJECT_COMMIT_UNCERTAIN" });
  await rm(apis);
  const recovered = await store.get(p.id);
  assert.equal(recovered.name, p.name);
  assert.equal(recovered.revision, 2);
  const second = await store.get(p.id);
  assert.deepEqual(second, recovered);
  await assert.rejects(
    readFile(path.join(directory, ".transaction.json")),
    /ENOENT/,
  );
  await assert.rejects(store.save(p), /其他窗口|已被其他/);
});
test("HTTP failed creation exposes recoverable project ID without claiming rollback or replaying create", async (t) => {
  const root = await temporary(t),
    app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
  });
  const save = app.store.save.bind(app.store);
  let attempted = 0,
    createdId;
  app.store.save = async (p, ...args) => {
    attempted++;
    createdId = p.id;
    await mkdir(app.store.directory(p.id), { recursive: true });
    await writeFile(path.join(app.store.directory(p.id), "apis"), "blocked");
    return save(p, ...args);
  };
  const response = await fetch(app.url + "/api/projects", {
    method: "POST",
    headers: { "x-local-token": app.token, "content-type": "application/json" },
    body: JSON.stringify({ name: "Create once" }),
  });
  assert.equal(response.status, 400);
  const result = await response.json();
  assert.equal(result.code, "PROJECT_COMMIT_UNCERTAIN");
  assert.equal(result.project_id, createdId);
  assert.equal(result.retry_safe, false);
  assert.equal(attempted, 1);
  assert.equal(JSON.stringify(result).includes(root), false);
  assert.equal(result.commit_outcome, "unknown");
  const again = await fetch(app.url + "/api/projects", {
    method: "POST",
    headers: { "x-local-token": app.token, "content-type": "application/json" },
    body: JSON.stringify({ name: "Unsafe repeated create" }),
  });
  const denied = await again.json();
  assert.equal(again.status, 400);
  assert.equal(denied.code, "PROJECT_RECOVERY_REQUIRED");
  assert.deepEqual(denied.project_ids, [createdId]);
  assert.equal(attempted, 1);
  app.store.save = save;
  await rm(path.join(app.store.directory(createdId), "apis"));
  assert.equal((await app.store.get(createdId)).name, "Create once");
  assert.equal((await app.store.list()).length, 1);
});
test("MCP reports uncertain update as machine-readable error and retains original project scope", async (t) => {
  const root = await temporary(t),
    store = new Store(root),
    p = await store.create("MCP");
  const apis = path.join(store.directory(p.id), "apis");
  await rm(apis, { recursive: true });
  await writeFile(apis, "blocked");
  const d = createMCP({ store, projects: [p.id], write: true });
  const result = await d({
    id: 1,
    method: "tools/call",
    params: {
      name: "localapi_sync_openapi",
      arguments: {
        projectId: p.id,
        document: {
          openapi: "3.0.3",
          info: { title: "fixture", version: "1" },
          paths: {
            "/echo": { get: { responses: { 200: { description: "OK" } } } },
          },
        },
      },
    },
  });
  assert.equal(result.result.isError, true);
  const error = JSON.parse(result.result.content[0].text);
  assert.equal(error.project_id, p.id);
  assert.equal(error.retry_safe, false);
  await rm(apis);
  const recovered = await store.get(p.id);
  assert.equal(recovered.requests.length, 1);
  assert.equal(
    (await store.get(p.id)).requests[0].id,
    recovered.requests[0].id,
  );
});

test("post-commit lock cleanup failure still returns project identity and never replays the save", async (t) => {
  const root = await temporary(t),
    store = new Store(root),
    p = await store.create("Before");
  const read = store.readUnlocked.bind(store);
  let reads = 0;
  store.readUnlocked = async (id) => {
    const value = await read(id);
    reads++;
    await writeFile(
      path.join(store.lockFile(id), "owner.json"),
      "{fixture-invalid-json",
    );
    return value;
  };
  p.name = "Already applied";
  await assert.rejects(
    store.save(p),
    (e) => e.code === "PROJECT_COMMIT_UNCERTAIN" && e.projectId === p.id,
  );
  assert.equal(reads, 1);
  const metadata = JSON.parse(
    await readFile(path.join(store.directory(p.id), "project.json"), "utf8"),
  );
  assert.equal(metadata.name, "Already applied");
  assert.equal(metadata.revision, 2);
  // Test-owned corrupted lock only; production never deletes an unknown lock owner.
  store.readUnlocked = read;
  await rm(store.lockFile(p.id), { recursive: true });
  assert.equal((await store.get(p.id)).name, "Already applied");
});

test("partial resource apply recovers the same transaction without incrementing revision again", async (t) => {
  const root = await temporary(t),
    store = new Store(root),
    p = await store.create("Before");
  p.requests = [
    { id: "api", name: "Before", method: "GET", url: "http://127.0.0.1/" },
  ];
  await store.save(p);
  const directory = store.directory(p.id),
    blocked = path.join(directory, "plans"),
    apiFile = path.join(
      directory,
      "apis",
      "key-" + Buffer.from("api").toString("base64url") + ".json",
    );
  await rm(blocked, { recursive: true });
  await writeFile(blocked, "blocked later collection");
  p.requests[0].name = "After";
  p.name = "After";
  await assert.rejects(store.save(p), { code: "PROJECT_COMMIT_UNCERTAIN" });
  assert.equal(JSON.parse(await readFile(apiFile, "utf8")).name, "After");
  assert.equal(
    JSON.parse(await readFile(path.join(directory, "project.json"), "utf8"))
      .name,
    "Before",
  );
  await rm(blocked);
  const recovered = await store.get(p.id);
  assert.equal(recovered.name, "After");
  assert.equal(recovered.requests[0].name, "After");
  assert.equal(recovered.revision, 3);
  assert.equal((await store.get(p.id)).revision, 3);
});

test("recovery outcome survives a secondary lock cleanup failure in both get and save", async (t) => {
  const root = await temporary(t),
    store = new Store(root),
    p = await store.create("Before");
  const apis = path.join(store.directory(p.id), "apis");
  await rm(apis, { recursive: true });
  await writeFile(apis, "blocked");
  p.name = "Journaled";
  await assert.rejects(store.save(p), { code: "PROJECT_COMMIT_UNCERTAIN" });
  const read = store.readUnlocked.bind(store);
  store.readUnlocked = async (id) => {
    try {
      return await read(id);
    } finally {
      await writeFile(
        path.join(store.lockFile(id), "owner.json"),
        "{bad-fixture-owner",
      );
    }
  };
  for (const operation of [() => store.get(p.id), () => store.save(p)]) {
    await assert.rejects(
      operation(),
      (e) => e.code === "PROJECT_COMMIT_UNCERTAIN" && e.projectId === p.id,
    );
    await rm(store.lockFile(p.id), { recursive: true });
  }
  store.readUnlocked = read;
  await rm(apis);
  assert.equal((await store.get(p.id)).name, "Journaled");
});

test("MCP recovery guard never enumerates damaged project IDs outside its grant", async (t) => {
  const root = await temporary(t),
    store = new Store(root),
    p = await store.create("Private broken project");
  const apis = path.join(store.directory(p.id), "apis");
  await rm(apis, { recursive: true });
  await writeFile(apis, "blocked");
  p.name = "Pending";
  await assert.rejects(store.save(p), { code: "PROJECT_COMMIT_UNCERTAIN" });
  const d = createMCP({ store, projects: [], write: true });
  const result = await d({
    id: 1,
    method: "tools/call",
    params: { name: "localapi_create_project", arguments: { name: "New" } },
  });
  assert.equal(result.result.isError, true);
  const error = JSON.parse(result.result.content[0].text);
  assert.equal(error.code, "PROJECT_RECOVERY_REQUIRED");
  assert.deepEqual(error.project_ids, []);
  assert.equal(JSON.stringify(error).includes(p.id), false);
});
