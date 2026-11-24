import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeRequest, toCurl, exportOpenAPI } from "../src/core.mjs";
import { prepareDefinitionExportScope } from "../src/definition-export-scope.mjs";
import { projectWithoutLoadRuns } from "../src/project-owner-projection.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { createApp } from "../src/server.mjs";
import { createMCP } from "../src/mcp.mjs";
import { readProject, writeProject } from "../src/project-files.mjs";
import { freezeServiceBinding } from "../src/environments.mjs";
import { Store } from "../src/runtime.mjs";
import {
  literalQueryEffectiveURL,
  validateLiteralQueryEditor,
} from "../src/literal-query-editor.mjs";

const full = "https://fixture.invalid/items?tag=a%2Bb&tag=a+b&flag&empty=#part";
const effective = full.replace("&tag=a+b", "");
const dormant = "private_fixture_excluded";
const projected = "https://fixture.invalid/items?live=1";

const rows = [
  { token: "tag=a%2Bb", enabled: true },
  { token: "tag=a+b", enabled: false },
  { token: "flag", enabled: true },
  { token: "empty=", enabled: true },
];
function projectWithCandidate(id = "project", url = effective, tokens = rows) {
  const request = normalizeRequest({ id: "request-a", method: "GET", url });
  return {
    id,
    settings: {},
    requests: [request],
    literalQueryEditor: {
      version: 1,
      projectId: id,
      entries: [
        {
          requestId: request.id,
          effectiveURL: url,
          rows: structuredClone(tokens),
        },
      ],
    },
  };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "workbench-literal-query-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const created = await store.create("Synthetic private UI");
  const candidate = projectWithCandidate(created.id);
  created.requests = candidate.requests;
  created.literalQueryEditor = candidate.literalQueryEditor;
  await store.save(created);
  return { root, store, p: created, dir: join(root, created.id) };
}

test("literal rows preserve occurrences and exact fragment, including all off then restore", () => {
  assert.equal(literalQueryEffectiveURL(effective, rows), effective);
  assert.equal(literalQueryEffectiveURL(effective, rows, true), full);
  const allOff = rows.map((row) => ({ ...row, enabled: false }));
  const canonical = "https://fixture.invalid/items#part";
  const sidecar = projectWithCandidate("project", canonical, allOff);
  assert.equal(literalQueryEffectiveURL(effective, allOff), canonical);
  assert.equal(literalQueryEffectiveURL(canonical, allOff, true), full);
  assert.deepEqual(
    validateLiteralQueryEditor(sidecar),
    sidecar.literalQueryEditor,
  );
});

test("malformed, ambiguous, foreign and inadmissible state never validates", () => {
  for (const edit of [
    (p) => p.literalQueryEditor.version++,
    (p) => {
      p.literalQueryEditorFormat = 1;
    },
    (p) => {
      p.literalQueryEditor.projectId = "other";
    },
    (p) => {
      p.literalQueryEditor.entries[0].requestId = "foreign";
    },
    (p) => {
      p.literalQueryEditor.entries.push(p.literalQueryEditor.entries[0]);
    },
    (p) => {
      p.literalQueryEditor.entries[0].rows[1].token = "a&b=1";
    },
    (p) => {
      p.literalQueryEditor.entries[0].rows[1].token = "secret=%";
    },
    (p) => {
      p.literalQueryEditor.entries[0].rows[1].token = "secret={{value}}";
    },
    (p) => {
      p.literalQueryEditor.entries[0].rows[1].enabled = "false";
    },
    (p) => {
      p.literalQueryEditor.entries[0].rows[1].enabled = true;
    },
    (p) => {
      p.literalQueryEditor.entries[0].rows = Array(1001).fill(rows[1]);
    },
    (p) => {
      p.requests[0].url = full;
    },
    (p) => {
      p.requests[0].sourceOperationId = "apipost:existing";
    },
    (p) => {
      p.requests[0].openapiOperation = { summary: "import" };
    },
    (p) => {
      p.requests[0].scriptURLMode = "sdk";
    },
    (p) => {
      p.requests[0].serviceId = "service";
    },
    (p) => {
      p.requests.push(p.requests[0]);
    },
  ]) {
    const p = projectWithCandidate();
    edit(p);
    assert.throws(() => validateLiteralQueryEditor(p), /URL 查询编辑状态/);
  }
  const p = projectWithCandidate();
  let call = 0;
  Object.defineProperty(p.literalQueryEditor.entries[0], "rows", {
    enumerable: true,
    get() {
      call++;
      return rows;
    },
  });
  assert.throws(() => validateLiteralQueryEditor(p), /URL 查询编辑状态/);
  assert.equal(call, 0);
});

test("restart and complete backup restore private state through the transactional ignored file", async (t) => {
  const { root, store, p, dir } = await fixture(t);
  const reopened = await new Store(root).get(p.id);
  assert.deepEqual(reopened.literalQueryEditor, p.literalQueryEditor);
  const privateFile = "history/literal-query-editor.json";
  assert(
    !JSON.stringify(await readFile(join(dir, "project.json"), "utf8")).includes(
      "literalQueryEditor",
    ),
  );
  assert(
    JSON.parse(await readFile(join(dir, privateFile), "utf8")).data.entries
      .length === 1,
  );
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const file of [privateFile, ".local-history.json", ".transaction.json"])
    assert.equal(
      execFileSync("git", ["check-ignore", file], {
        cwd: dir,
        encoding: "utf8",
      }).trim(),
      file,
    );
  const backup = JSON.parse(JSON.stringify(reopened));
  const restored = await store.restore(backup);
  assert.notEqual(restored.id, p.id);
  assert.deepEqual(
    restored.literalQueryEditor.entries,
    p.literalQueryEditor.entries,
  );
  assert.equal(restored.literalQueryEditor.projectId, restored.id);
  assert.deepEqual(
    (await new Store(root).get(restored.id)).literalQueryEditor,
    restored.literalQueryEditor,
  );
  assert.equal(restored.requests[0].url, effective);
  const clone = await mkdtemp(join(tmpdir(), "workbench-def-only-"));
  t.after(() => rm(clone, { recursive: true, force: true }));
  const { cp } = await import("node:fs/promises");
  await cp(dir, clone, {
    recursive: true,
    filter: (candidate) =>
      !["history", ".local-history.json", ".git"].includes(
        candidate.split(/[\\/]/).at(-1),
      ),
  });
  assert.equal((await readProject(clone, p.id)).literalQueryEditor, undefined);
  assert.equal((await readProject(clone, p.id)).requests[0].url, effective);
});

test("normal writer omission preserves unchanged URL, but URL change then ABA never restores dormant data", async (t) => {
  const { root, store, p, dir } = await fixture(t);
  const legacy = await store.get(p.id);
  delete legacy.literalQueryEditor;
  legacy.name = "Ordinary metadata edit";
  await store.save(legacy);
  assert.deepEqual(
    (await new Store(root).get(p.id)).literalQueryEditor,
    p.literalQueryEditor,
  );
  const previous = await store.get(p.id);
  const next = await store.get(p.id);
  next.requests[0].url = projected;
  await store.save(next);
  assert.equal(next.literalQueryEditor, undefined);
  await assert.rejects(store.save(previous), /修改|版本/);
  const returnURL = await store.get(p.id);
  returnURL.requests[0].url = effective;
  await store.save(returnURL);
  assert.equal((await new Store(root).get(p.id)).literalQueryEditor, undefined);
  await assert.rejects(
    readFile(join(dir, "history/literal-query-editor.json")),
    { code: "ENOENT" },
  );
});

test("out-of-process request file change and ABA cannot revive its stale witness", async (t) => {
  const { root, p, dir } = await fixture(t);
  const [name] = await readdir(join(dir, "apis"));
  const path = join(dir, "apis", name);
  const original = await readFile(path, "utf8");
  const edited = JSON.parse(original);
  edited.url = projected;
  await writeFile(path, JSON.stringify(edited));
  assert.equal((await new Store(root).get(p.id)).literalQueryEditor, undefined);
  await writeFile(path, original);
  const aba = await new Store(root).get(p.id);
  assert.equal(aba.requests[0].url, effective);
  assert.equal(aba.literalQueryEditor, undefined);
});

test("interrupted journal reconciles both active URL and its matching private rows", async (t) => {
  const { root, store, p, dir } = await fixture(t);
  const after = await store.get(p.id);
  const nextRows = rows.map((row) => ({ ...row, enabled: false }));
  const next = literalQueryEffectiveURL(effective, nextRows);
  after.requests[0].url = next;
  Object.assign(after.literalQueryEditor.entries[0], {
    effectiveURL: next,
    rows: nextRows,
  });
  await writeFile(join(dir, ".transaction.json"), JSON.stringify(after));
  const promoted = await new Store(root).get(p.id);
  assert.equal(promoted.requests[0].url, next);
  assert.deepEqual(promoted.literalQueryEditor, after.literalQueryEditor);
  assert.equal(
    literalQueryEffectiveURL(
      next,
      promoted.literalQueryEditor.entries[0].rows,
      true,
    ),
    full,
  );
  await assert.rejects(readFile(join(dir, ".transaction.json")), {
    code: "ENOENT",
  });
});

test("runtime, cURL, definitions, history and MCP disclose only canonical active request", async (t) => {
  const { store, p } = await fixture(t);
  const candidate = await store.get(p.id);
  candidate.requests[0].url = projected;
  candidate.literalQueryEditor.entries[0] = {
    requestId: "request-a",
    effectiveURL: projected,
    rows: [
      { token: "live=1", enabled: true },
      { token: "dormant=" + dormant, enabled: false },
    ],
  };
  await store.save(candidate);
  const active = await store.get(p.id);
  const executionView = freezeServiceBinding(active, active.requests[0]);
  assert.equal(executionView.url, projected);
  assert(!JSON.stringify(executionView).includes(dormant));
  assert(String(toCurl(active.requests[0])).includes(projected));
  assert(!String(toCurl(active.requests[0])).includes(dormant));
  assert(!JSON.stringify(exportOpenAPI(active)).includes(dormant));
  assert(!JSON.stringify(exportApipost(active)).includes(dormant));
  const scoped = prepareDefinitionExportScope(active, {
    mode: "explicit",
    resources: [
      { kind: "api", id: "request-a" },
      { kind: "globals", id: "configuration" },
    ],
  });
  assert.equal(scoped.project.literalQueryEditor, undefined);
  assert(!JSON.stringify(scoped).includes(dormant));
  assert(!JSON.stringify(active.requestDefinitionHistory).includes(dormant));
  const mcp = createMCP({ store, projects: [p.id] });
  const detail = await mcp({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "localapi_get_api_detail",
      arguments: { projectId: p.id, apiId: "request-a" },
    },
  });
  assert(JSON.stringify(detail).includes(projected));
  assert(!JSON.stringify(detail).includes(dormant));
});

test("an intentional bad sidecar or activity write cannot alter committed owner state", async (t) => {
  const { store, p, dir } = await fixture(t);
  const edited = await store.get(p.id);
  edited.literalQueryEditor.entries[0].rows[1].token = "changed=valid";
  await assert.rejects(
    store.save(edited, { activity: true }),
    /URL 查询编辑状态/,
  );
  const invalid = await store.get(p.id);
  invalid.literalQueryEditor.entries[0].rows[1].token = "invalid#secret";
  await assert.rejects(store.save(invalid), /URL 查询编辑状态/);
  const foreign = await store.get(p.id);
  foreign.literalQueryEditor.entries[0].requestId = "other-request";
  await assert.rejects(store.save(foreign), /URL 查询编辑状态/);
  const current = await store.get(p.id);
  assert.equal(current.configRevision, p.configRevision);
  assert.deepEqual(current.literalQueryEditor, p.literalQueryEditor);
  await assert.rejects(readFile(join(dir, ".transaction.json")), {
    code: "ENOENT",
  });
});

test("explicit owner backup route retains exact state; physical state metadata cannot live in tracked manifest", async (t) => {
  const { root, store, p, dir } = await fixture(t);
  const app = await createApp({ root, port: 0 });
  t.after(() => app.close());
  const base = new URL(app.launchUrl);
  const headers = {
    "x-local-token": new URLSearchParams(base.hash.slice(1)).get("token"),
  };
  const path = new URL("/api/projects/" + p.id + "/export?format=backup", base);
  assert.equal((await fetch(path)).status, 403);
  const response = await fetch(path, { headers });
  assert.equal(response.status, 200);
  const backup = await response.json();
  assert.deepEqual(backup.literalQueryEditor, p.literalQueryEditor);
  const restored = await store.restore(backup);
  assert.equal(restored.literalQueryEditor.projectId, restored.id);
  assert.deepEqual(
    restored.literalQueryEditor.entries,
    p.literalQueryEditor.entries,
  );
  const trackedPath = join(dir, "project.json");
  const tracked = JSON.parse(await readFile(trackedPath, "utf8"));
  tracked.literalQueryEditor = backup.literalQueryEditor;
  await writeFile(trackedPath, JSON.stringify(tracked));
  await assert.rejects(store.get(p.id), /状态清单无效/);
});

test("normal identical request regeneration and same-byte journal recovery preserve the sidecar", async (t) => {
  const { root, store, p, dir } = await fixture(t);
  const original = await store.get(p.id);
  const [name] = await readdir(join(dir, "apis"));
  const requestPath = join(dir, "apis", name);
  const originalRequest = await readFile(requestPath, "utf8");
  await writeProject(dir, original);
  assert.equal(await readFile(requestPath, "utf8"), originalRequest);
  assert.deepEqual(
    (await new Store(root).get(p.id)).literalQueryEditor,
    original.literalQueryEditor,
  );
  await writeFile(join(dir, ".transaction.json"), JSON.stringify(original));
  const recovered = await new Store(root).get(p.id);
  assert.equal(await readFile(requestPath, "utf8"), originalRequest);
  assert.deepEqual(recovered.literalQueryEditor, original.literalQueryEditor);
  assert.equal(recovered._diskFingerprint, original._diskFingerprint);
});

test("Store rejects a proxy before inspecting the added editor properties", async (t) => {
  const { store, p } = await fixture(t);
  let called = 0;
  const wrapper = new Proxy(p, {
    getOwnPropertyDescriptor() {
      called++;
      throw Error("must not inspect");
    },
  });
  await assert.rejects(store.save(wrapper), /不能为代理对象/);
  assert.equal(called, 0);
});

test("missing or malformed private sidecar leaves canonical reads, config and activity available without erasure", async (t) => {
  for (const issue of ["missing", "invalid"]) {
    const { root, store, p, dir } = await fixture(t);
    const file = join(dir, "history/literal-query-editor.json");
    const good = await readFile(file);
    const bad = "{invalid synthetically";
    if (issue === "missing") await rm(file);
    else await writeFile(file, bad);
    const active = await new Store(root).get(p.id);
    assert.equal(active.literalQueryEditorIssue, issue);
    assert.equal(active.literalQueryEditor, undefined);
    assert.equal(active.requests[0].url, effective);
    assert(!String(toCurl(active.requests[0])).includes("tag=a+b"));
    const tryReplacing = await store.get(p.id);
    tryReplacing.literalQueryEditor = p.literalQueryEditor;
    await assert.rejects(store.save(tryReplacing), /需要恢复/);
    active.name = "Canonical metadata change";
    await store.save(active);
    const activity = await store.get(p.id);
    const revision = activity.configRevision;
    // Ordinary local activity persistence; no request is sent.
    activity.history = [];
    await store.save(activity, { activity: true });
    assert.equal(activity.literalQueryEditorIssue, issue);
    assert.equal(activity.configRevision, revision);
    assert.equal(activity.requests[0].url, effective);
    const manifest = JSON.parse(
      await readFile(join(dir, ".local-history.json"), "utf8"),
    );
    assert.equal(manifest.literalQueryEditorFormat, 1);
    const tracked = JSON.parse(
      await readFile(join(dir, "project.json"), "utf8"),
    );
    assert.equal(tracked.literalQueryEditorIssue, undefined);
    assert.equal(tracked._retainLiteralQueryEditorFile, undefined);
    if (issue === "missing")
      await assert.rejects(readFile(file), { code: "ENOENT" });
    else assert.equal(await readFile(file, "utf8"), bad);

    // Same owner's restored physical file is checked against the still-current
    // request identity after ordinary saves, not treated as a new draft.
    await writeFile(file, good);
    const repaired = await new Store(root).get(p.id);
    assert.equal(repaired.literalQueryEditorIssue, undefined);
    assert.deepEqual(repaired.literalQueryEditor, p.literalQueryEditor);
    assert.equal(repaired.name, "Canonical metadata change");
  }
});

test("a committed canonical journal rolls forward while preserving an invalid private file and marker", async (t) => {
  const { root, store, p, dir } = await fixture(t);
  const sidecar = join(dir, "history/literal-query-editor.json");
  const old = await store.get(p.id);
  delete old.literalQueryEditor;
  old.name = "Canonical recovery";
  await writeFile(sidecar, "{synthetic bad value");
  const setting = join(dir, "settings/project.json");
  const parked = setting + ".fixture-parked";
  await assert.rejects(
    writeProject(dir, old, {
      retainLiteralQueryFile: true,
      beforePublish() {
        renameSync(setting, parked);
        mkdirSync(setting);
      },
    }),
    (error) => error?.name === "ProjectCommitUncertain",
  );
  const journal = JSON.parse(
    await readFile(join(dir, ".transaction.json"), "utf8"),
  );
  assert.equal(journal._retainLiteralQueryEditorFile, true);
  assert.equal(journal.literalQueryEditor, undefined);
  assert.equal(journal.literalQueryEditorIssue, undefined);
  await rm(setting, { recursive: true });
  renameSync(parked, setting);
  const recovered = await new Store(root).get(p.id);
  assert.equal(recovered.name, "Canonical recovery");
  assert.equal(recovered.literalQueryEditorIssue, "invalid");
  assert.equal(recovered.literalQueryEditor, undefined);
  assert.equal(recovered._retainLiteralQueryEditorFile, undefined);
  assert.equal(await readFile(sidecar, "utf8"), "{synthetic bad value");
  assert.equal(
    JSON.parse(await readFile(join(dir, ".local-history.json"), "utf8"))
      .literalQueryEditorFormat,
    1,
  );
  await assert.rejects(readFile(join(dir, ".transaction.json")), {
    code: "ENOENT",
  });
});

test("degraded owner reads diagnose without disclosing private bytes; incomplete backups are refused", async (t) => {
  const { root, store, p, dir } = await fixture(t);
  const canonical = await store.get(p.id);
  canonical.requests[0].url = projected;
  canonical.literalQueryEditor.entries[0] = {
    requestId: "request-a",
    effectiveURL: projected,
    rows: [
      { token: "live=1", enabled: true },
      { token: "dormant=" + dormant, enabled: false },
    ],
  };
  await store.save(canonical);
  const secret = "synthetic_corrupted_opaque";
  await writeFile(join(dir, "history/literal-query-editor.json"), "{" + secret);
  const app = await createApp({ root, port: 0 });
  t.after(() => app.close());
  const base = new URL(app.launchUrl);
  const headers = {
    "x-local-token": new URLSearchParams(base.hash.slice(1)).get("token"),
  };
  const local = "/api/projects/" + p.id;
  const get = (suffix = "") =>
    fetch(new URL(local + suffix, base), { headers });
  const view = await get();
  assert.equal(view.status, 200);
  const owned = await view.json();
  assert.equal(owned.literalQueryEditorIssue, "invalid");
  const mcpEnvelope = projectWithoutLoadRuns({ project: owned });
  assert.equal(mcpEnvelope.project.literalQueryEditorIssue, undefined);
  assert.equal(projectWithoutLoadRuns(canonical).literalQueryEditor, undefined);
  assert.equal(
    prepareDefinitionExportScope(owned, {
      mode: "explicit",
      resources: [{ kind: "api", id: "request-a" }],
    }).project.literalQueryEditorIssue,
    undefined,
  );
  assert.equal(owned.requests[0].url, projected);
  assert(!JSON.stringify(owned).includes(secret));
  for (const suffix of [
    "/export",
    "/export?format=native",
    "/export?format=backup",
  ]) {
    const fullBackup = await get(suffix);
    assert.equal(fullBackup.status, 400);
    const error = await fullBackup.text();
    assert.match(error, /无法生成完整项目备份/);
    assert(!error.includes(secret));
  }
  const definition = await get("/export?format=openapi");
  assert.equal(definition.status, 200);
  const def = await definition.text();
  assert(!def.includes("literalQueryEditorIssue"));
  assert(!def.includes(secret));
});
