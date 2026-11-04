import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { fork } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { Store } from "../src/runtime.mjs";
import { normalizeRequest, importIntoProject } from "../src/core.mjs";
import { acquireFileLock } from "../src/file-lock.mjs";
import {
  listRequestDefinitionHistory,
  getRequestDefinitionVersion,
} from "../src/request-definition-history.mjs";

const json = (value) => JSON.parse(JSON.stringify(value));
const lineage = (p) =>
  p.requestDefinitionHistory.entries.find(
    (e) => e.requestId === "api" && !e.retired,
  );
async function setup(t, url = "http://127.0.0.1:1/never-execute") {
  const root = await mkdtemp(path.join(tmpdir(), "definition-history-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root),
    project = await store.create("history"),
    peer = await store.create("peer");
  project.requests = [
    normalizeRequest({
      id: "api",
      name: "v1",
      method: "POST",
      url,
      bodyType: "json",
      body: '{"value":1}',
      auth: { type: "bearer", token: "static-old" },
    }),
    normalizeRequest({ id: "other", name: "other", url }),
  ];
  await store.save(project);
  return { root, store, project, peer };
}
async function edit(store, key, name) {
  const p = await store.get(key);
  p.requests[0].name = name;
  await store.save(p);
  return p;
}
async function operation(store, p, details) {
  return store.changeRequestDefinitionHistory(p.id, {
    configRevision: p.configRevision,
    requestId: "api",
    lineageId: lineage(p).lineageId,
    ...details,
  });
}
async function noJournal(store, p) {
  await assert.rejects(
    readFile(path.join(store.directory(p.id), ".transaction.json")),
    { code: "ENOENT" },
  );
}

test("Store captures prior full definitions in the same persisted revision and leaves activity/no-op saves versionless", async (t) => {
  const { root, store, project, peer } = await setup(t);
  const peerBefore = await store.get(peer.id),
    first = json(project.requests[0]);
  let p = await edit(store, project.id, "v2");
  assert.equal(lineage(p).currentVersion, 2);
  assert.deepEqual(lineage(p).versions[0].definition, first);
  const originalHistory = json(p.requestDefinitionHistory);
  await store.save(p);
  assert.deepEqual(p.requestDefinitionHistory, originalHistory);
  await store.append(p.id, "history", {
    id: "already-executed",
    status: "passed",
  });
  p = await new Store(root).get(p.id);
  assert.deepEqual(p.requestDefinitionHistory, originalHistory);
  assert.equal(p.history[0].id, "already-executed");
  assert.deepEqual(await store.get(peer.id), peerBefore);
  await noJournal(store, p);
});

test("ordinary saves cannot forge/drop history and activity cannot bypass definition capture", async (t) => {
  const { store, project } = await setup(t);
  const p = await edit(store, project.id, "v2"),
    before = await store.get(p.id);
  for (const activity of [false, true]) {
    const forged = structuredClone(before);
    forged.requestDefinitionHistory.entries[0].currentTag = "forged";
    await assert.rejects(store.save(forged, { activity }), /服务端/);
    assert.deepEqual(await store.get(p.id), before);
  }
  const changed = structuredClone(before);
  changed.requests[0].name = "bypass";
  await assert.rejects(
    store.save(changed, { activity: true }),
    /活动记录.*接口定义/,
  );
  const omitted = structuredClone(before);
  delete omitted.requestDefinitionHistory;
  omitted.name = "legitimate unrelated update";
  await store.save(omitted);
  assert.deepEqual(
    omitted.requestDefinitionHistory,
    before.requestDefinitionHistory,
  );
  await noJournal(store, omitted);
});

test("tags, same-content restoration and clear preserve monotonic history identities without replaying effects", async (t) => {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits++;
    res.end("side effect");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const { root, store, project, peer } = await setup(
    t,
    `http://127.0.0.1:${server.address().port}/write`,
  );
  const otherBefore = json(project.requests[1]),
    peerBefore = await store.get(peer.id);
  let p = await operation(store, project, {
    kind: "tag",
    historyId: "current",
    tag: "v1-tag",
  });
  p = await edit(store, p.id, "v2");
  const old = lineage(p).versions[0];
  assert.equal(old.tag, "v1-tag");
  p = await operation(store, p, {
    kind: "tag",
    historyId: old.id,
    tag: "release",
  });
  const beforeRestoreVersion = lineage(p).currentVersion;
  p = await operation(store, p, { kind: "restore", historyId: old.id });
  assert.equal(p.requests[0].name, "v1");
  assert.equal(p.requests[0].auth.token, "static-old");
  assert.equal(lineage(p).currentVersion, beforeRestoreVersion + 1);
  assert.equal(lineage(p).versions.at(-1).definition.name, "v2");
  p = await operation(store, p, { kind: "restore", historyId: old.id });
  assert.equal(lineage(p).currentVersion, beforeRestoreVersion + 2);
  p = await operation(store, p, { kind: "clear", all: true });
  assert.equal(lineage(p).versions.length, 0);
  assert.equal(lineage(p).currentVersion, beforeRestoreVersion + 2);
  p = await edit(store, p.id, "after clear");
  assert.equal(lineage(p).currentVersion, beforeRestoreVersion + 3);
  assert.equal(lineage(p).versions[0].version, beforeRestoreVersion + 2);
  assert.deepEqual(p.requests[1], otherBefore);
  assert.deepEqual(await new Store(root).get(peer.id), peerBefore);
  assert.equal(hits, 0);
});

test("soft deletion keeps lineage, simultaneous content changes archive, hard ID reuse cannot restore a retired lineage", async (t) => {
  const { store, project } = await setup(t),
    originalLineage = lineage(project).lineageId;
  let p = await store.get(project.id);
  p.requests[0].deletedAt = new Date().toISOString();
  await store.save(p);
  assert.equal(lineage(p).currentVersion, 1);
  p.requests[0].name = "changed tombstone";
  await store.save(p);
  assert.equal(lineage(p).currentVersion, 2);
  assert.equal(
    Object.hasOwn(lineage(p).versions[0].definition, "deletedAt"),
    false,
  );
  await assert.rejects(
    operation(store, p, {
      kind: "restore",
      historyId: lineage(p).versions[0].id,
    }),
    /活动/,
  );
  delete p.requests[0].deletedAt;
  await store.save(p);
  const target = json(p.requests[0]);
  p.requests = p.requests.filter((r) => r.id !== "api");
  await store.save(p);
  const old = p.requestDefinitionHistory.entries.find(
    (e) => e.lineageId === originalLineage,
  );
  assert.equal(old.retired, true);
  assert.equal(old.versions.at(-1).definition.name, "changed tombstone");
  p.requests.unshift(target);
  await store.save(p);
  assert.notEqual(lineage(p).lineageId, originalLineage);
  const before = await store.get(p.id);
  await assert.rejects(
    store.changeRequestDefinitionHistory(p.id, {
      configRevision: p.configRevision,
      kind: "restore",
      requestId: "api",
      lineageId: originalLineage,
      historyId: old.versions[0].id,
    }),
    /活动/,
  );
  assert.deepEqual(await store.get(p.id), before);
});

test("stale config and activity saves reject without inventing extra historical versions", async (t) => {
  const { root, store, project } = await setup(t),
    second = new Store(root);
  const a = await store.get(project.id),
    b = await second.get(project.id);
  a.requests[0].name = "winner";
  b.requests[0].name = "stale";
  await store.save(a);
  for (const activity of [false, true])
    await assert.rejects(
      second.save(structuredClone(b), { activity }),
      /其他窗口|已被其他/,
    );
  const p = await second.get(project.id);
  assert.equal(p.requests[0].name, "winner");
  assert.equal(lineage(p).versions.length, 1);
  assert.equal(lineage(p).currentVersion, 2);
  await noJournal(store, p);
});

test(
  "queued history cancellation keeps revision, files and peer unchanged",
  { timeout: 15000 },
  async (t) => {
    const { root, store, project, peer } = await setup(t),
      p = await edit(store, project.id, "v2");
    const before = await store.get(p.id),
      peerBefore = await store.get(peer.id),
      controller = new AbortController();
    // Save the exact operation input before holding the lock; the public mutation
    // will queue its real read behind this lock and still has to observe abort.
    const release = await acquireFileLock(store.lockFile(p.id));
    let settled = false;
    const result = store
      .changeRequestDefinitionHistory(
        p.id,
        {
          configRevision: p.configRevision,
          kind: "restore",
          requestId: "api",
          lineageId: lineage(p).lineageId,
          historyId: lineage(p).versions[0].id,
        },
        { signal: controller.signal },
      )
      .then(
        () => {
          settled = true;
          return null;
        },
        (error) => {
          settled = true;
          return error;
        },
      );
    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      controller.abort();
    } finally {
      await release();
    }
    assert.equal((await result)?.code, "STORE_SAVE_ABORTED");
    assert.deepEqual(await new Store(root).get(p.id), before);
    assert.deepEqual(await store.get(peer.id), peerBefore);
    await noJournal(store, p);
  },
);

test("backup rebinds history owner to fresh project identity and does not normalize unsupported current fields away", async (t) => {
  const { root, store, project } = await setup(t),
    p = await edit(store, project.id, "v2");
  const before = await store.get(p.id),
    copy = await store.restore(json(p));
  assert.notEqual(copy.id, p.id);
  assert.equal(copy.requestDefinitionHistory.projectId, copy.id);
  assert.deepEqual(
    copy.requestDefinitionHistory.entries,
    p.requestDefinitionHistory.entries,
  );
  assert.deepEqual(copy.requests, p.requests);
  assert.deepEqual(await new Store(root).get(p.id), before);
  assert.equal(
    (await new Store(root).get(copy.id)).requestDefinitionHistory.projectId,
    copy.id,
  );
  const malformed = json(p);
  malformed.requests[0].futureUnsupportedDefinition = {
    value: "do not discard",
  };
  const count = (await store.list()).length;
  await assert.rejects(store.restore(malformed), /不能无损恢复/);
  assert.equal((await store.list()).length, count);
});

test("missing declared history fails closed and valid interrupted journal recovers the exact new version once", async (t) => {
  const { root, store, project, peer } = await setup(t),
    p = await edit(store, project.id, "v2"),
    peerBefore = await store.get(peer.id);
  const file = path.join(store.directory(p.id), "history", "definitions.json"),
    bytes = await readFile(file);
  await rm(file);
  await assert.rejects(store.save(structuredClone(p)), { code: "ENOENT" });
  await noJournal(store, p);
  await writeFile(file, bytes);
  const apis = path.join(store.directory(p.id), "apis");
  const journalFile = path.join(store.directory(p.id), ".transaction.json");
  const originalRename = fs.promises.rename;
  let injected = 0;
  // Test-only barrier on the actual builtin rename: publish the real journal
  // first, then damage this temporary project's API directory before returning
  // to writeProject's apply phase. Reads and commits are never stubbed.
  fs.promises.rename = async (source, destination) => {
    await originalRename(source, destination);
    if (destination === journalFile) {
      injected++;
      await rm(apis, { recursive: true });
      await writeFile(
        apis,
        "block apply only after actual journal publication",
      );
    }
  };
  syncBuiltinESMExports();
  try {
    p.requests[0].name = "v3";
    await assert.rejects(store.save(p), { code: "PROJECT_COMMIT_UNCERTAIN" });
    assert.equal(injected, 1);
  } finally {
    fs.promises.rename = originalRename;
    syncBuiltinESMExports();
  }
  const journal = JSON.parse(
    await readFile(
      path.join(store.directory(p.id), ".transaction.json"),
      "utf8",
    ),
  );
  assert.equal(journal.requests[0].name, "v3");
  assert.equal(lineage(journal).currentVersion, 3);
  assert.equal(lineage(journal).versions.at(-1).definition.name, "v2");
  await rm(apis);
  const recovered = await new Store(root).get(p.id);
  assert.deepEqual(
    recovered.requestDefinitionHistory,
    journal.requestDefinitionHistory,
  );
  assert.deepEqual(await new Store(root).get(p.id), recovered);
  assert.deepEqual(await store.get(peer.id), peerBefore);
  await noJournal(store, p);
});

test("material OpenAPI sync writes capture prior definitions through the same Store history gate", async (t) => {
  const { store, project } = await setup(t);
  const spec = (title) => ({
    openapi: "3.0.3",
    info: { title: "fixture", version: "1" },
    paths: {
      "/history": {
        get: { summary: title, responses: { 200: { description: "OK" } } },
      },
    },
  });
  importIntoProject(project, spec("initial"), { sync: true });
  await store.save(project);
  const api = project.requests.find((r) => r.url.includes("/history"));
  assert.ok(api);
  importIntoProject(project, spec("updated"), { sync: true });
  await store.save(project);
  const entry = project.requestDefinitionHistory.entries.find(
    (e) => e.requestId === api.id && !e.retired,
  );
  assert.equal(entry.currentVersion, 2);
  assert.equal(entry.versions.length, 1);
  assert.equal(entry.versions[0].definition.name, "initial");
});

test("activity evidence may exceed old restore envelope without disabling configuration, history or fresh backup restore", async (t) => {
  const { root, store, project, peer } = await setup(t),
    p = await edit(store, project.id, "v2"),
    history = json(p.requestDefinitionHistory);
  await store.append(p.id, "history", {
    id: "large-existing-execution",
    body: "x".repeat(12 * 1024 * 1024),
  });
  const large = await new Store(root).get(p.id);
  assert.ok(
    Buffer.byteLength(JSON.stringify({ document: large })) > 12 * 1024 * 1024,
  );
  assert.deepEqual(large.requestDefinitionHistory, history);
  assert.equal(
    listRequestDefinitionHistory(large, { requestId: "api" }).total,
    1,
  );
  assert.equal(
    getRequestDefinitionVersion(large, {
      requestId: "api",
      historyId: lineage(large).versions[0].id,
    }).definition.name,
    "v1",
  );
  const peerBefore = await store.get(peer.id);
  const evidence = json(large.history);
  large.name = "configuration is not a backup HTTP envelope";
  const saved = await store.save(large);
  const reopened = await new Store(root).get(p.id);
  assert.equal(reopened.name, large.name);
  assert.deepEqual(reopened.history, evidence);
  assert.deepEqual(reopened.requestDefinitionHistory, history);
  const restored = await store.restore(saved);
  assert.notEqual(restored.id, saved.id);
  assert.equal(restored.requestDefinitionHistory.projectId, restored.id);
  assert.deepEqual(restored.requestDefinitionHistory.entries, history.entries);
  assert.deepEqual(restored.history, evidence);
  assert.deepEqual(await store.get(p.id), reopened);
  assert.deepEqual(await store.get(peer.id), peerBefore);
  await noJournal(store, p);
  await noJournal(store, restored);
});

function child(t, root, id, name) {
  const worker = fork(
    fileURLToPath(
      new URL(
        "./fixtures/definition-history-store-worker.mjs",
        import.meta.url,
      ),
    ),
    [root, id, name],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  let output = "";
  worker.stderr.on("data", (chunk) => {
    output += chunk;
  });
  t.after(async () => {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill();
    await exited.catch(() => {});
  });
  const exited = new Promise((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", (code, signal) => {
      code === 0
        ? resolve()
        : reject(Error(`worker ${code}/${signal}: ${output}`));
    });
  });
  exited.catch(() => {});
  const message = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(Error("worker read timeout: " + output)),
      10000,
    );
    worker.once("message", (value) => {
      clearTimeout(timeout);
      resolve(value);
    });
    worker.once("exit", () => clearTimeout(timeout));
  });
  return { worker, message, exited };
}

test(
  "two actual Store processes race on one config revision: one history commit wins without cross-project changes",
  { timeout: 20000 },
  async (t) => {
    const { root, store, project, peer } = await setup(t),
      beforePeer = await store.get(peer.id);
    const a = child(t, root, project.id, "process-A"),
      b = child(t, root, project.id, "process-B");
    const ready = await Promise.all([a.message, b.message]);
    assert.deepEqual(
      ready.map((m) => m.type),
      ["ready", "ready"],
    );
    const results = [a, b].map(
      (c) => new Promise((resolve) => c.worker.once("message", resolve)),
    );
    a.worker.send({ type: "save" });
    b.worker.send({ type: "save" });
    const observed = await Promise.all(results);
    await Promise.all([a.exited, b.exited]);
    assert.equal(observed.filter((m) => m.type === "saved").length, 1);
    assert.equal(observed.filter((m) => m.type === "conflict").length, 1);
    const p = await new Store(root).get(project.id);
    assert.ok(["process-A", "process-B"].includes(p.requests[0].name));
    assert.equal(lineage(p).currentVersion, 2);
    assert.equal(lineage(p).versions.length, 1);
    assert.equal(lineage(p).versions[0].definition.name, "v1");
    assert.deepEqual(await store.get(peer.id), beforePeer);
    await noJournal(store, p);
  },
);

test("definition restore refuses a removed historical folder without silently recreating it", async (t) => {
  const { store, project } = await setup(t);
  project.folders = ["before"];
  project.requests[0].folder = "before";
  await store.save(project);
  project.folders = ["after"];
  project.requests[0].folder = "after";
  await store.save(project);
  const entry = lineage(project),
    old = entry.versions.find((v) => v.definition.folder === "before");
  assert.ok(old);
  const before = await store.get(project.id);
  await assert.rejects(
    operation(store, project, { kind: "restore", historyId: old.id }),
    /目录已不存在/,
  );
  assert.deepEqual(await store.get(project.id), before);
});

test("historical native binding cannot bypass the current graph identity or mutate frozen plans", async (t) => {
  const { nativeInheritanceFixture } = await import(
    "./fixtures/native-inheritance.mjs"
  );
  const { root, store } = await setup(t),
    p = await store.create("native graph");
  importIntoProject(p, nativeInheritanceFixture(), {
    inheritanceMode: "preserve",
  });
  await store.save(p);
  const api = p.requests.find((r) => r.nativeInheritance);
  assert.ok(api);
  const moved = await store.editNativeInheritance(p.id, {
    configRevision: p.configRevision,
    operation: { type: "move-request", requestId: api.id, parentId: "0" },
  });
  const entry = moved.requestDefinitionHistory.entries.find(
    (e) => e.requestId === api.id && !e.retired,
  );
  assert.equal(entry.versions.length, 1);
  const before = await new Store(root).get(p.id);
  await assert.rejects(
    store.changeRequestDefinitionHistory(p.id, {
      configRevision: moved.configRevision,
      kind: "restore",
      requestId: api.id,
      lineageId: entry.lineageId,
      historyId: entry.versions[0].id,
    }),
    /继承|身份|目录/,
  );
  assert.deepEqual(await store.get(p.id), before);
});

test(
  "8MiB current definitions survive first edits, fresh backup identity and concurrent history quota rejection",
  { timeout: 30000 },
  async (t) => {
    const { root, store, project, peer } = await setup(t);
    const peerBefore = await store.get(peer.id);
    let current = await store.get(project.id);
    current.requests[0].bodyType = "raw";
    current.requests[0].body = "x".repeat(8 * 1024 * 1024);
    current = await store.save(current);
    const firstLarge = json(current.requests[0]);
    current.requests[0].name = "large edit one";
    current = await store.save(current);
    assert.deepEqual(lineage(current).versions.at(-1).definition, firstLarge);
    current.requests[0].name = "large edit two";
    current = await store.save(current);
    assert.equal(
      lineage(current).versions.at(-1).definition.body,
      firstLarge.body,
    );
    assert(Buffer.byteLength(JSON.stringify(current)) > 12 * 1024 * 1024);
    const source = await store.get(current.id);
    const copy = await store.restore(source);
    assert.notEqual(copy.id, source.id);
    assert.equal(copy.requestDefinitionHistory.projectId, copy.id);
    assert.deepEqual(copy.requests, source.requests);
    assert.deepEqual(
      copy.requestDefinitionHistory.entries,
      source.requestDefinitionHistory.entries,
    );
    assert.deepEqual(await new Store(root).get(source.id), source);
    const one = new Store(root),
      two = new Store(root);
    const a = await one.get(source.id),
      b = await two.get(source.id);
    a.requests[0].name = "writer one";
    b.requests[0].name = "writer two";
    const outcomes = await Promise.allSettled([one.save(a), two.save(b)]);
    assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
    const rejected = outcomes.find((r) => r.status === "rejected");
    assert.match(rejected.reason.message, /其他窗口|其他修改|重新加载/);
    const accepted = await new Store(root).get(source.id);
    assert.equal(
      lineage(accepted).currentVersion,
      lineage(source).currentVersion + 1,
    );
    assert.deepEqual(
      lineage(accepted).versions.slice(0, -1),
      lineage(source).versions,
    );
    const overQuota = structuredClone(accepted);
    overQuota.requests[0].name = "must remain uncommitted";
    await assert.rejects(store.save(overQuota), /32 MiB|容量|33554432/);
    assert.deepEqual(await new Store(root).get(source.id), accepted);
    assert.deepEqual(await store.get(peer.id), peerBefore);
    await noJournal(store, accepted);
    const afterActivity = await store.append(source.id, "history", {
      id: "quota-independent-activity",
      status: "passed",
    });
    assert.equal(afterActivity.id, accepted.id);
    assert.equal(afterActivity.history[0].id, "quota-independent-activity");
    assert.deepEqual(
      (await store.get(source.id)).requestDefinitionHistory,
      accepted.requestDefinitionHistory,
    );
  },
);
