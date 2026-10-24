import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Store } from "../src/runtime.mjs";
import { readProject, writeProject } from "../src/project-files.mjs";
test("split project files isolate API diffs and recover an interrupted transaction", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "split-project-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const p = {
    id: "project",
    version: 1,
    requests: [{ id: "api", name: "First" }],
    environments: [],
    plans: [],
    cases: [],
    settings: {},
    globalVariables: {},
    servers: [],
    history: [],
    runs: [],
    documents: [],
    dictionary: [],
    folders: [],
  };
  await writeProject(root, p);
  assert.equal((await readdir(path.join(root, "apis"))).length, 1);
  const next = { ...p, requests: [{ id: "api", name: "After crash" }] };
  await writeFile(path.join(root, ".transaction.json"), JSON.stringify(next));
  assert.equal(
    (await readProject(root, "project")).requests[0].name,
    "After crash",
  );
  await assert.rejects(
    readFile(path.join(root, ".transaction.json")),
    /ENOENT/,
  );
  await rm(path.join(root, "history"), { recursive: true });
  assert.deepEqual((await readProject(root, "project")).history, []);
});
test("Store migrates legacy files on save while keeping the original backup", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legacy-project-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const p = {
    id: "legacy",
    version: 1,
    name: "Old",
    revision: 3,
    requests: [],
    environments: [{ id: "dev", name: "Dev", variables: {} }],
    plans: [],
    runs: [],
    history: [],
    settings: {},
  };
  const original = JSON.stringify(p);
  await writeFile(path.join(root, "legacy.json"), original);
  const store = new Store(root);
  const loaded = await store.get("legacy");
  loaded.name = "Migrated";
  await store.save(loaded);
  assert.equal((await store.get("legacy")).name, "Migrated");
  assert.equal(
    await readFile(path.join(root, "legacy.json"), "utf8"),
    original,
  );
  assert.equal(
    JSON.parse(
      await readFile(path.join(root, "legacy", "project.json"), "utf8"),
    ).storageFormat,
    2,
  );
  assert.equal((await store.list()).length, 1);
});

test("external Git-style API edits are read and cannot be overwritten by a stale UI save", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "git-edits-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const project = await store.create("Git-safe");
  project.requests = [{ id: "api", name: "Before", url: "http://localhost" }];
  await store.save(project);
  const stale = await store.get(project.id);
  const apiFile = path.join(
    root,
    project.id,
    "apis",
    (await readdir(path.join(root, project.id, "apis")))[0],
  );
  const edited = JSON.parse(await readFile(apiFile, "utf8"));
  edited.name = "Edited by Git";
  await writeFile(apiFile, JSON.stringify(edited));
  assert.equal((await store.get(project.id)).requests[0].name, "Edited by Git");
  stale.name = "UI rename";
  await assert.rejects(store.save(stale), /其他窗口|文件/);
});
