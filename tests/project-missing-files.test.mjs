import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
  chmod,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Store } from "../src/runtime.mjs";
import { normalizeRequest } from "../src/core.mjs";

const recordFile = (id) =>
  (/^[a-f0-9-]{36}$/i.test(id)
    ? id
    : "key-" + Buffer.from(id).toString("base64url")) + ".json";
async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "missing-project-file-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function bytes(directory) {
  const output = {};
  async function visit(folder, relative = "") {
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const key = path.join(relative, entry.name),
        file = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        output[key + path.sep] = "directory";
        await visit(file, key);
      } else output[key] = (await readFile(file)).toString("base64");
    }
  }
  await visit(directory);
  return output;
}
async function populated(t) {
  const root = await temporary(t),
    store = new Store(root),
    project = await store.create("A");
  project.requests = [
    normalizeRequest({ id: "api", name: "A", url: "http://127.0.0.1/unused" }),
  ];
  project.plans = [{ id: "plan", name: "Plan", steps: [] }];
  project.cases = [
    {
      id: "case",
      name: "Case",
      sourceRequestId: "api",
      request: project.requests[0],
    },
  ];
  project.protocols = [
    { id: "wire", name: "TCP", type: "tcp", url: "127.0.0.1", port: 1234 },
  ];
  project.documents = [{ id: "doc", title: "A", content: "Original" }];
  project.dictionary = [{ id: "model", name: "Model", schema: {} }];
  await store.save(project);
  return { root, store, project };
}
async function commitLatest(root, key) {
  const other = new Store(root);
  await other.append(key, "history", { id: "history-B", marker: "latest" });
  const latest = await other.get(key);
  latest.name = "B";
  latest.archived = true;
  latest.settings.fixture = "new configuration";
  latest.requests[0].name = "B";
  latest.requests[0].deletedAt = "2026-01-01T00:00:00.000Z";
  await other.save(latest);
  return other.get(key);
}
const required = [
  ["API", () => path.join("apis", recordFile("api"))],
  ["environment", (p) => path.join("envs", recordFile(p.environments[0].id))],
  ["plan", () => path.join("plans", recordFile("plan"))],
  ["case", () => path.join("cases", recordFile("case"))],
  ["protocol", () => path.join("protocols", recordFile("wire"))],
  ["settings", () => "settings/project.json"],
  ["globals", () => "envs/globals.json"],
  ["servers", () => "envs/servers.json"],
  ["documents", () => "settings/documents.json"],
  ["dictionary", () => "settings/dictionary.json"],
  ["folders", () => "settings/folders.json"],
  ["manifest", () => "project.json"],
];
for (const [category, relative] of required)
  test(`missing required ${category} refuses stale configuration and activity saves without rewriting any project bytes`, async (t) => {
    const { root, store, project } = await populated(t),
      stale = await store.get(project.id),
      latest = await commitLatest(root, project.id),
      peer = await store.create("Unaffected"),
      peerBefore = await bytes(store.directory(peer.id)),
      directory = store.directory(project.id),
      file = path.join(directory, relative(project)),
      savedBytes = await readFile(file);
    // Only this test's temporary project is damaged. The manifest still lists
    // missing collection children; no mocked Store read supplies the failure.
    await rm(file);
    const before = await bytes(directory);
    stale.name = "Stale additive edit";
    stale.requests.push(
      normalizeRequest({ id: "imported", url: "http://127.0.0.1/unused" }),
    );
    await assert.rejects(store.get(project.id), { code: "ENOENT" });
    for (const activity of [false, true]) {
      await assert.rejects(store.save(structuredClone(stale), { activity }), {
        code: "ENOENT",
      });
      assert.deepEqual(await bytes(directory), before);
      await assert.rejects(readFile(file), { code: "ENOENT" });
      await assert.rejects(
        readFile(path.join(directory, ".transaction.json")),
        {
          code: "ENOENT",
        },
      );
      assert.deepEqual(await bytes(store.directory(peer.id)), peerBefore);
    }
    // Reinstalling the exact fixture bytes reveals B, not a replay of A.
    await writeFile(file, savedBytes);
    assert.deepEqual(await new Store(root).get(project.id), latest);
    await assert.rejects(store.save(stale), /其他窗口|文件/);
    assert.deepEqual(await new Store(root).get(project.id), latest);
  });

for (const custom of [false, true])
  test(`missing whole ${custom ? "custom" : "default"} project cannot resurrect an old identity`, async (t) => {
    const home = await temporary(t),
      root = path.join(home, "registry"),
      customRoot = path.join(home, "custom"),
      store = new Store(root),
      project = await store.create("Original", custom ? customRoot : undefined),
      stale = structuredClone(project);
    await store.append(project.id, "history", { id: "new-history" });
    const latest = await store.get(project.id);
    latest.name = "B";
    latest.archived = true;
    await store.save(latest);
    await rm(store.directory(project.id), { recursive: true });
    const before = await bytes(home);
    await assert.rejects(store.save(stale), { code: "ENOENT" });
    assert.deepEqual(await bytes(home), before);
    await assert.rejects(readdir(store.directory(project.id)), {
      code: "ENOENT",
    });
    await assert.rejects(new Store(root).get(project.id), { code: "ENOENT" });
  });

test("save has no implicit fresh-identity upsert even when revision fields are absent", async (t) => {
  const root = await temporary(t),
    store = new Store(root),
    source = await store.create("Source"),
    fresh = { ...source, id: "not-created" };
  for (const key of ["revision", "configRevision", "_diskFingerprint"])
    delete fresh[key];
  await assert.rejects(store.save(fresh), { code: "ENOENT" });
  await assert.rejects(readdir(store.directory(fresh.id)), { code: "ENOENT" });
  assert.deepEqual(await store.get(source.id), source);
});

test("missing split manifest never falls back to the retained legacy backup", async (t) => {
  const root = await temporary(t),
    store = new Store(root),
    legacy = {
      id: "legacy",
      version: 1,
      name: "Legacy",
      revision: 4,
      requests: [],
      environments: [],
      plans: [],
      settings: {},
    },
    legacyFile = path.join(root, "legacy.json"),
    original = JSON.stringify(legacy);
  await writeFile(legacyFile, original);
  const migrated = await store.get(legacy.id);
  migrated.name = "Migrated";
  await store.save(migrated);
  const directory = store.directory(legacy.id),
    manifest = path.join(directory, "project.json"),
    saved = await readFile(manifest);
  await rm(manifest);
  const before = await bytes(directory);
  await assert.rejects(store.get(legacy.id), { code: "ENOENT" });
  await assert.rejects(store.save(migrated), { code: "ENOENT" });
  assert.deepEqual(await bytes(directory), before);
  assert.equal(await readFile(legacyFile, "utf8"), original);
  await writeFile(manifest, saved);
  assert.deepEqual(await store.get(legacy.id), migrated);
  // With the entire migrated directory absent, legacy-only compatibility still
  // applies, but a post-migration snapshot must not overwrite the older source.
  await rm(directory, { recursive: true });
  await assert.rejects(store.save(migrated), /其他窗口|文件/);
  await assert.rejects(readdir(directory), { code: "ENOENT" });
  assert.equal(await readFile(legacyFile, "utf8"), original);
});

for (const unpublishedTemp of [false, true])
  test(`legacy migration retries a ${unpublishedTemp ? "temporary-journal-only" : "bare"} precommit directory`, async (t) => {
    const root = await temporary(t),
      store = new Store(root),
      source = {
        id: "legacy",
        version: 1,
        name: "Legacy",
        revision: 7,
        requests: [],
        environments: [],
        plans: [],
        settings: {},
      },
      legacyFile = path.join(root, "legacy.json"),
      original = JSON.stringify(source),
      directory = path.join(root, source.id);
    await writeFile(legacyFile, original);
    await mkdir(directory);
    if (unpublishedTemp)
      await writeFile(
        path.join(
          directory,
          ".transaction.json.11111111-1111-4111-8111-111111111111.tmp",
        ),
        "unpublished fixture",
      );
    const project = await store.get(source.id);
    project.name = "Migrated";
    await store.save(project);
    assert.equal(project.revision, 8);
    assert.equal(project.configRevision, 8);
    assert.equal((await new Store(root).get(source.id)).name, "Migrated");
    assert.equal(await readFile(legacyFile, "utf8"), original);
  });

test(
  "real pre-journal legacy migration permission failure leaves a retryable source",
  {
    skip: process.platform === "win32" || process.getuid?.() === 0,
  },
  async (t) => {
    const root = await temporary(t),
      store = new Store(root),
      source = {
        id: "legacy",
        version: 1,
        name: "Legacy",
        revision: 7,
        requests: [],
        environments: [],
        plans: [],
        settings: {},
      },
      directory = path.join(root, source.id),
      legacyFile = path.join(root, "legacy.json"),
      original = JSON.stringify(source);
    await writeFile(legacyFile, original);
    await mkdir(directory);
    const project = await store.get(source.id);
    project.name = "Migrated";
    await chmod(directory, 0o500);
    try {
      await assert.rejects(store.save(project), { code: "EACCES" });
      assert.deepEqual(await readdir(directory), []);
      assert.equal(await readFile(legacyFile, "utf8"), original);
    } finally {
      await chmod(directory, 0o700);
    }
    assert.equal((await store.get(source.id)).name, "Legacy");
    await store.save(project);
    assert.equal(project.revision, 8);
    assert.equal((await new Store(root).get(source.id)).name, "Migrated");
    assert.equal(await readFile(legacyFile, "utf8"), original);
  },
);

test("optional files retain defaults and a published journal still recovers missing required children", async (t) => {
  const { root, store, project } = await populated(t),
    directory = store.directory(project.id);
  for (const relative of [
    "history/requests.json",
    "history/runs.json",
    "history/protocols.json",
    "settings/parameter-dictionary.json",
  ])
    await rm(path.join(directory, relative));
  const read = await store.get(project.id);
  for (const key of ["history", "runs", "protocolRuns", "parameterDictionary"])
    assert.deepEqual(read[key], []);
  read.name = "Still writable";
  await store.save(read);
  const journal = {
    ...read,
    name: "Journal committed",
    revision: read.revision + 1,
    configRevision: read.configRevision + 1,
  };
  await writeFile(
    path.join(directory, ".transaction.json"),
    JSON.stringify(journal),
  );
  await rm(path.join(directory, "apis", recordFile("api")));
  const recovered = await new Store(root).get(project.id);
  assert.equal(recovered.name, journal.name);
  assert.equal(recovered.revision, journal.revision);
  assert.equal(recovered.configRevision, journal.configRevision);
  assert.deepEqual(recovered.requests, journal.requests);
  assert.deepEqual(await new Store(root).get(project.id), recovered);
  await assert.rejects(readFile(path.join(directory, ".transaction.json")), {
    code: "ENOENT",
  });
  await assert.rejects(store.save(read), /其他窗口|文件/);
});

test("explicit restore preserves damaged source and unrelated unresolved creation intent across restart", async (t) => {
  const { root, store, project } = await populated(t),
    document = await store.get(project.id),
    sourceDirectory = store.directory(project.id),
    blockedBase = path.join(root, "unavailable-base");
  await rm(path.join(sourceDirectory, "settings", "documents.json"));
  const sourceBefore = await bytes(sourceDirectory);
  // A real non-directory base makes this unrelated creation intent unresolved;
  // no mock read/error and no deletion of unowned data is involved.
  await writeFile(blockedBase, "fixture blocks custom directory");
  const pending = { unrelated: blockedBase };
  await writeFile(
    path.join(root, ".creations.json"),
    JSON.stringify({ version: 1, projects: pending }),
  );
  await assert.rejects(store.create("Not a recovery request"), {
    code: "PROJECT_RECOVERY_REQUIRED",
  });
  const restored = await store.restore(document);
  assert.notEqual(restored.id, document.id);
  assert.equal(restored.revision, 1);
  assert.equal(restored.configRevision, 1);
  assert.deepEqual(restored.requests, document.requests);
  assert.deepEqual(restored.documents, document.documents);
  assert.deepEqual(await bytes(sourceDirectory), sourceBefore);
  assert.equal(
    await readFile(blockedBase, "utf8"),
    "fixture blocks custom directory",
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(root, ".creations.json"), "utf8"))
      .projects,
    pending,
  );
  const restarted = new Store(root);
  assert.deepEqual(await restarted.get(restored.id), restored);
  await assert.rejects(restarted.get(document.id), { code: "ENOENT" });
  await assert.rejects(restarted.get("unrelated"), {
    code: "PROJECT_RECOVERY_REQUIRED",
  });
  assert.deepEqual(
    JSON.parse(await readFile(path.join(root, ".creations.json"), "utf8"))
      .projects,
    pending,
  );
  assert.deepEqual(await bytes(sourceDirectory), sourceBefore);
});
