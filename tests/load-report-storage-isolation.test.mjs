import test from "node:test";
import { createMCP } from "../src/mcp.mjs";
import { Store } from "../src/runtime.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  readProject,
  writeProject,
  projectFingerprint,
} from "../src/project-files.mjs";
import {
  restoreProject,
  importIntoProject,
  normalizeRequest,
} from "../src/core.mjs";
import {
  projectOwnerResponse,
  projectWithoutLoadRuns,
} from "../src/project-owner-projection.mjs";
import { prepareDefinitionExportScope } from "../src/definition-export-scope.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";

const pending = () => ({
  version: 1,
  id: randomUUID(),
  kind: "one-shot",
  state: "pending",
  startedAt: "2026-01-01T00:00:00.000Z",
});
const terminal = () => ({
  ...pending(),
  state: "failed",
  finishedAt: "2026-01-01T00:00:01.000Z",
});
const project = () => ({
  version: 1,
  id: "fixture",
  name: "Fixture",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  requests: [],
  environments: [{ id: "default", name: "Default", variables: {} }],
  settings: {},
  plans: [],
  history: [],
  runs: [],
  protocolRuns: [],
  documents: [],
  dictionary: [],
  folders: [],
  cases: [],
  protocols: [],
  globalVariables: {},
  servers: [],
});
async function directory(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "load-receipts-storage-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("load receipts have separate private history storage, survive reopen and journal recovery, and never affect definition fingerprint", async (t) => {
  const dir = await directory(t),
    p = { ...project(), loadRuns: [pending(), terminal()] };
  await writeProject(dir, p);
  assert.deepEqual(
    JSON.parse(
      await readFile(path.join(dir, "history/load-reports.json"), "utf8"),
    ),
    p.loadRuns,
  );
  assert.equal(
    Object.hasOwn(
      JSON.parse(await readFile(path.join(dir, "project.json"), "utf8")),
      "loadRuns",
    ),
    false,
  );
  assert.deepEqual((await readProject(dir, p.id)).loadRuns, p.loadRuns);
  assert.equal(
    projectFingerprint(p),
    projectFingerprint({ ...p, loadRuns: [] }),
  );
  const next = { ...p, loadRuns: [terminal()] };
  await writeFile(path.join(dir, ".transaction.json"), JSON.stringify(next));
  assert.deepEqual((await readProject(dir, p.id)).loadRuns, next.loadRuns);
});

test("legacy projects and restores do not acquire fabricated load receipts", async (t) => {
  const dir = await directory(t),
    p = project();
  await writeProject(dir, p);
  assert.equal(Object.hasOwn(await readProject(dir, p.id), "loadRuns"), false);
  await assert.rejects(
    readFile(path.join(dir, "history/load-reports.json")),
    /ENOENT/,
  );
  assert.equal(Object.hasOwn(restoreProject(p), "loadRuns"), false);
});

test("backup restore preserves pending and terminal evidence unchanged under new project identity", () => {
  const p = { ...project(), loadRuns: [pending(), terminal()] };
  const result = restoreProject(p);
  assert.notEqual(result.id, p.id);
  assert.deepEqual(result.loadRuns, p.loadRuns);
  result.loadRuns[0].state = "changed";
  assert.equal(p.loadRuns[0].state, "pending");
});

test("invalid records are rejected before publication and during read/recovery/restore", async (t) => {
  const dir = await directory(t),
    p = { ...project(), loadRuns: [pending()] };
  await writeProject(dir, p);
  const invalid = {
    ...p,
    loadRuns: [{ ...pending(), response: { body: "not allowed" } }],
  };
  await assert.rejects(writeProject(dir, invalid), /压测/);
  assert.deepEqual((await readProject(dir, p.id)).loadRuns, p.loadRuns);
  assert.throws(() => restoreProject(invalid), /压测/);
  assert.throws(() => restoreProject({ ...p, loadRuns: null }), /压测/);
  await assert.rejects(writeProject(dir, { ...p, loadRuns: null }), /压测/);
  for (const records of [
    Array.from({ length: 11 }, pending),
    Array.from({ length: 51 }, terminal),
  ])
    assert.throws(() => restoreProject({ ...p, loadRuns: records }), /压测/);
  await writeFile(path.join(dir, ".transaction.json"), JSON.stringify(invalid));
  await assert.rejects(readProject(dir, p.id), /压测/);
  await rm(path.join(dir, ".transaction.json"));
  await writeFile(
    path.join(dir, "history/load-reports.json"),
    JSON.stringify(invalid.loadRuns),
  );
  await assert.rejects(readProject(dir, p.id), /压测/);
});

test("owner and existing MCP project envelopes omit receipts without changing nested user literals", () => {
  const p = {
    ...project(),
    loadRuns: [pending()],
    requests: [{ body: { loadRuns: "literal" } }],
  };
  for (const projectView of [projectOwnerResponse, projectWithoutLoadRuns]) {
    const view = projectView(p);
    assert.equal(Object.hasOwn(view, "loadRuns"), false);
    assert.equal(view.requests, p.requests);
    const wrapped = projectView({
      project: p,
      result: { loadRuns: "literal" },
    });
    assert.equal(Object.hasOwn(wrapped.project, "loadRuns"), false);
    assert.equal(wrapped.result.loadRuns, "literal");
    const literal = { loadRuns: "literal" };
    assert.equal(projectView(literal), literal);
  }
  assert.equal(p.loadRuns.length, 1);
});

test("definition selection and native interchange cannot export or forge load receipts", () => {
  const p = {
    ...project(),
    loadRuns: [pending()],
    requests: [
      normalizeRequest({
        id: "api",
        name: "API",
        url: "https://example.invalid",
      }),
    ],
  };
  const selected = prepareDefinitionExportScope(p, { mode: "all" });
  assert.equal(Object.hasOwn(selected.project, "loadRuns"), false);
  const clean = { ...p };
  delete clean.loadRuns;
  assert.deepEqual(exportApipost(p), exportApipost(clean));
  assert.deepEqual(exportApipostDirectory(p), exportApipostDirectory(clean));
  const doc = exportApipost(clean);
  doc.loadRuns = [terminal()];
  const target = { ...project(), loadRuns: [pending()] },
    before = structuredClone(target.loadRuns);
  assert.throws(() => importIntoProject(target, doc), /loadRuns/);
  assert.deepEqual(target.loadRuns, before);
  delete doc.loadRuns;
  importIntoProject(target, doc);
  assert.deepEqual(target.loadRuns, before);
});

test("existing MCP project-returning tools do not acquire load receipt visibility", async () => {
  const p = { ...project(), loadRuns: [pending()] };
  const dispatch = createMCP({ store: { create: async () => p }, write: true });
  const response = await dispatch({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "localapi_create_project", arguments: { name: "Fixture" } },
  });
  assert.notEqual(
    response.result.isError,
    true,
    response.result.content[0].text,
  );
  assert.equal(
    Object.hasOwn(JSON.parse(response.result.content[0].text), "loadRuns"),
    false,
  );
  assert.equal(p.loadRuns.length, 1);
});

test("Store restart and full restore preserve receipts without exposing them as project-list metadata", async (t) => {
  const root = await directory(t),
    store = new Store(root),
    p = await store.create("receipt restart");
  const receipts = [pending(), terminal()];
  // Seed the documented disk boundary, not editable project saves.
  await writeProject(store.directory(p.id), { ...p, loadRuns: receipts });
  const reopened = new Store(root),
    read = await reopened.get(p.id);
  assert.deepEqual(read.loadRuns, receipts);
  assert.equal(Object.hasOwn((await reopened.list())[0], "loadRuns"), false);
  const restored = restoreProject(read);
  await writeProject(path.join(root, restored.id), restored);
  assert.deepEqual((await new Store(root).get(restored.id)).loadRuns, receipts);
});

test("load receipt manifest fails closed for missing evidence, embedded history and unknown versions", async (t) => {
  const dir = await directory(t),
    p = { ...project(), loadRuns: [pending()] };
  await writeProject(dir, p);
  const manifestPath = path.join(dir, "project.json"),
    file = path.join(dir, "history/load-reports.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.loadReportFormat, 1);
  assert.equal(
    Object.hasOwn(await readProject(dir, p.id), "loadReportFormat"),
    false,
  );
  await rm(file);
  await assert.rejects(readProject(dir, p.id), /ENOENT/);
  for (const changed of [
    { ...manifest, loadReportFormat: 2 },
    { ...manifest, loadReportFormat: null },
    { ...manifest, loadReportFormat: "1" },
    { ...manifest, loadRuns: [] },
  ]) {
    await writeFile(manifestPath, JSON.stringify(changed));
    await assert.rejects(readProject(dir, p.id), /压测报告清单/);
  }
  // Full journal recovery re-establishes both manifest and evidence together.
  await writeFile(path.join(dir, ".transaction.json"), JSON.stringify(p));
  assert.deepEqual((await readProject(dir, p.id)).loadRuns, p.loadRuns);
  const recovered = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(recovered.loadReportFormat, 1);
});

test("legacy unmarked projects do not gain evidence from an orphan history file", async (t) => {
  const dir = await directory(t),
    p = project();
  await writeProject(dir, p);
  const manifest = JSON.parse(
    await readFile(path.join(dir, "project.json"), "utf8"),
  );
  assert.equal(Object.hasOwn(manifest, "loadReportFormat"), false);
  await writeFile(
    path.join(dir, "history/load-reports.json"),
    JSON.stringify([pending()]),
  );
  assert.equal(Object.hasOwn(await readProject(dir, p.id), "loadRuns"), false);
  await writeProject(dir, p);
  await assert.rejects(
    readFile(path.join(dir, "history/load-reports.json")),
    /ENOENT/,
  );
});
