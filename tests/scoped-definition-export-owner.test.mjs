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
    assert.deepEqual(preview.body.options, {
      modelNameMode: "namespaced",
      databaseMode: null,
    });
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

const selected = (format = "apipost") => ({
  format,
  selection: { mode: "explicit", resources: [{ kind: "api", id: "chosen" }] },
});
const acceptance = (input, preview) => ({
  ...input,
  configRevision: preview.configRevision,
  scopeDigest: preview.scope.digest,
  acceptedDependencies: preview.scope.dependencies,
});

test("owner requires exact preview dependencies, output digest and current config; failures preserve complete storage", async (t) => {
  const f = await fixture(t),
    before = await f.app.store.get(f.project.id);
  const input = selected(),
    preview = (await f.post("export-preview", input)).body;
  assert.ok(preview.scope.dependencies.length);
  const valid = acceptance(input, preview);
  for (const change of [
    { acceptedDependencies: [] },
    {
      acceptedDependencies: [
        ...valid.acceptedDependencies,
        { kind: "api", id: "other" },
      ],
    },
    {
      acceptedDependencies: [
        ...valid.acceptedDependencies,
        valid.acceptedDependencies[0],
      ],
    },
    { scopeDigest: "0".repeat(64) },
    { configRevision: before.configRevision - 1 },
    { format: "apipost-directory" },
    { modelNameMode: "preserve" },
    { selection: { mode: "all" } },
  ]) {
    const refused = await f.post("export-selection", { ...valid, ...change });
    assert.equal(refused.status, 400, JSON.stringify(change));
    assert.equal(Object.hasOwn(refused.body, "document"), false);
    assert.equal(JSON.stringify(refused.body).includes("scope-secret"), false);
  }
  assert.deepEqual(await f.app.store.get(f.project.id), before);
  const changed = await f.app.store.get(f.project.id);
  changed.requests[0].name = "Changed";
  const saved = await f.app.store.save(changed);
  assert.equal((await f.post("export-selection", valid)).status, 400);
  assert.deepEqual(await f.app.store.get(f.project.id), saved);
  assert.equal(f.sends(), 0);
});

test("owner route and argument boundaries fail closed while existing complete backup remains unchanged", async (t) => {
  const f = await fixture(t),
    before = await f.app.store.get(f.project.id);
  for (const suffix of [
    "export-preview?unknown=true",
    "export-preview/nested",
    "export-selection/nested",
  ]) {
    assert.notEqual((await f.post(suffix, selected())).status, 200, suffix);
  }
  assert.equal(
    (await fetch(f.base + "/export-preview", { headers: f.headers })).status,
    405,
  );
  assert.equal(
    (
      await fetch(f.base + "/export-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(selected()),
      })
    ).status,
    403,
  );
  for (const change of [
    { format: "backup" },
    {
      selection: {
        mode: "explicit",
        resources: [{ kind: "api", id: "missing" }],
      },
    },
    {
      selection: {
        mode: "explicit",
        resources: [{ kind: "plan-bundle", id: "definitions" }],
      },
    },
    { unknown: true },
    { databaseMode: "credentials" },
    { selection: { mode: "all", resources: [] } },
  ]) {
    const r = await f.post("export-preview", { ...selected(), ...change });
    assert.equal(r.status, 400, JSON.stringify(change));
  }
  const full = await fetch(f.base + "/export", { headers: f.headers }).then(
    (r) => r.json(),
  );
  assert.deepEqual(full, before);
  assert.deepEqual(await f.app.store.get(f.project.id), before);
  const archived = await f.app.store.get(f.project.id);
  archived.archived = true;
  await f.app.store.save(archived);
  assert.equal((await f.post("export-preview", selected())).status, 400);
  assert.equal(f.sends(), 0);
});

test("unselected unsupported raw definition does not poison export; selected raw remains explicit failure", async (t) => {
  const f = await fixture(t);
  let p = await f.app.store.get(f.project.id);
  p.requests[1] = normalizeRequest({
    ...p.requests[1],
    bodyType: "raw",
    body: "<private/>",
    postmanRawBody: { version: 1, language: "xml" },
  });
  // Use a saved unsupported field already rejected by the native adapter,
  // without changing runtime normalization or executing either request.
  p.requests[1].scripts = { pre: "console.log('private-marker')", post: "" };
  p = await f.app.store.save(p);
  const preview = await f.post("export-preview", selected());
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const bad = await f.post("export-preview", {
    format: "apipost",
    selection: { mode: "explicit", resources: [{ kind: "api", id: "other" }] },
  });
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  assert.equal(JSON.stringify(bad.body).includes("private-marker"), false);
  assert.deepEqual(await f.app.store.get(f.project.id), p);
  assert.equal(f.sends(), 0);
});

test("owner selected sample closes live owner and groups, persists a new target and reopens without replay", async (t) => {
  const { nativeSampleExportFixture } = await import(
    "./fixtures/apipost-sample-export.mjs"
  );
  const f = await fixture(t);
  let p = await f.app.store.get(f.project.id);
  importIntoProject(
    p,
    nativeSampleExportFixture(
      f.project.requests[0].url.replace(/\/chosen$/, ""),
    ),
  );
  p = await f.app.store.save(p);
  const sample = p.cases.find((x) => x.name === "grouped");
  assert.ok(sample);
  const input = {
    format: "apipost-directory",
    selection: {
      mode: "explicit",
      resources: [{ kind: "case", id: sample.id }],
    },
  };
  const preview = await f.post("export-preview", input);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.ok(
    preview.body.scope.dependencies.some(
      (x) => x.kind === "api" && x.id === sample.sourceRequestId,
    ),
  );
  const response = await f.post(
    "export-selection",
    acceptance(input, preview.body),
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  let target = await f.app.store.create("Imported selection");
  importIntoProject(target, response.body.document);
  target = await f.app.store.save(target);
  const reopened = await new Store(f.root).get(target.id);
  assert.deepEqual(reopened, target);
  assert.equal(reopened.requests.length, 1);
  assert.equal(reopened.cases.length, 1);
  assert.equal(reopened.cases[0].name, sample.name);
  assert.equal(reopened.cases[0].request.url, sample.request.url);
  assert.ok(reopened.caseFolders.some((x) => x.name === "Group"));
  assert.equal(reopened.history.length, 0);
  assert.equal(reopened.runs.length, 0);
  assert.deepEqual(await f.app.store.get(p.id), p);
  assert.equal(f.sends(), 0);
});

test("owner body arriving after configuration change previews a fresh locked Store snapshot", async (t) => {
  const f = await fixture(t);
  const originalGet = f.app.store.get.bind(f.app.store);
  let readReady;
  const ready = new Promise((resolve) => {
    readReady = resolve;
  });
  let calls = 0;
  f.app.store.get = async (...args) => {
    const value = await originalGet(...args);
    if (args[0] === f.project.id && ++calls === 1) readReady();
    return value;
  };
  t.after(() => {
    f.app.store.get = originalGet;
  });
  const encoded = JSON.stringify(selected());
  const req = http.request(f.base + "/export-preview", {
    method: "POST",
    headers: { ...f.headers, "content-length": Buffer.byteLength(encoded) },
  });
  const response = new Promise((resolve, reject) => {
    req.once("error", reject);
    req.once("response", (res) => {
      let data = "";
      res.on("data", (x) => {
        data += x;
      });
      res.once("error", reject);
      res.on("end", () =>
        resolve({ status: res.statusCode, body: JSON.parse(data) }),
      );
    });
  });
  t.after(() => req.destroy());
  req.write(encoded.slice(0, 10));
  await ready;
  const changed = await originalGet(f.project.id);
  changed.requests[0].name = "Fresh after body started";
  const saved = await f.app.store.save(changed);
  req.end(encoded.slice(10));
  const preview = await response;
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.configRevision, saved.configRevision);
  assert.ok(calls >= 2);
  assert.deepEqual(await originalGet(f.project.id), saved);
  assert.equal(f.sends(), 0);
});

test("owner API selection closes recursive models and preserves literal ref data through both native imports", async (t) => {
  const f = await fixture(t);
  let p = await f.app.store.get(f.project.id);
  const a = {
    type: "object",
    properties: { b: { $ref: "#/components/schemas/B" } },
    example: { $ref: "https://literal.invalid/not-a-dependency" },
  };
  const b = {
    type: "object",
    properties: { a: { $ref: "#/components/schemas/A" } },
  };
  p.dictionary = [
    { id: "A", name: "A", folderId: "mf", schema: a },
    { id: "B", name: "B", schema: b },
    { id: "unused", name: "Unused", schema: { type: "string" } },
  ];
  p.modelFolders = [{ id: "mf", name: "Models" }];
  p.openapiComponents = { schemas: { A: a, B: b, unused: { type: "string" } } };
  p.requests[0].schema = { $ref: "#/components/schemas/A" };
  p = await f.app.store.save(p);
  for (const format of ["apipost", "apipost-directory"]) {
    const input = { ...selected(format), modelNameMode: "preserve" };
    const preview = await f.post("export-preview", input);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    for (const id of ["A", "B"])
      assert.ok(
        preview.body.scope.dependencies.some(
          (x) => x.kind === "model" && x.id === id,
        ),
      );
    assert.equal(
      preview.body.scope.included.some(
        (x) => x.kind === "model" && x.id === "unused",
      ),
      false,
    );
    const refused = await f.post("export-preview", {
      ...input,
      selection: { ...input.selection, exclude: [{ kind: "model", id: "B" }] },
    });
    assert.equal(refused.status, 400);
    const response = await f.post(
      "export-selection",
      acceptance(input, preview.body),
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    let target = await f.app.store.create("Model target " + format);
    importIntoProject(target, response.body.document, {
      modelNameMode: "preserve",
    });
    target = await f.app.store.save(target);
    const reopened = await new Store(f.root).get(target.id);
    assert.deepEqual(reopened, target);
    assert.equal(reopened.dictionary.length, 2);
    assert.equal(reopened.requests.length, 1);
    const ma = reopened.dictionary.find((x) => x.name === "A"),
      mb = reopened.dictionary.find((x) => x.name === "B");
    assert.ok(ma && mb);
    assert.equal(ma.schema.properties.b.$ref, "#/components/schemas/" + mb.id);
    assert.equal(mb.schema.properties.a.$ref, "#/components/schemas/" + ma.id);
    assert.deepEqual(ma.schema.example, a.example);
    assert.equal(
      reopened.requests[0].schema.$ref,
      "#/components/schemas/" + ma.id,
    );
    assert.ok(reopened.modelFolders.some((x) => x.name === "Models"));
  }
  assert.deepEqual(await f.app.store.get(p.id), p);
  assert.equal(f.sends(), 0);
});

test("owner native selection requires explicit database rebind and exports only inert connection placeholders", async (t) => {
  const f = await fixture(t);
  let p = await f.app.store.get(f.project.id);
  const { nativeDatabaseFixture } = await import(
    "./fixtures/apipost-database.mjs"
  );
  const staging = {
    id: "db-staging",
    name: "DB staging",
    requests: [],
    environments: [],
    settings: {},
  };
  importIntoProject(staging, nativeDatabaseFixture());
  p.settings.apipostDatabases = staging.settings.apipostDatabases;
  p = await f.app.store.save(p);
  assert.equal((await f.post("export-preview", selected())).status, 400);
  const input = { ...selected(), databaseMode: "rebind" };
  const preview = await f.post("export-preview", input);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.options.databaseMode, "rebind");
  assert.ok(preview.body.scope.dependencies.some((x) => x.kind === "globals"));
  const exported = await f.post(
    "export-selection",
    acceptance(input, preview.body),
  );
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  assert.equal(
    JSON.stringify(exported.body.document).includes("private-host.invalid"),
    false,
  );
  assert.equal(
    JSON.stringify(exported.body.document).includes(
      "discard-this-fictional-password",
    ),
    false,
  );
  const link = exported.body.document.global.db_link;
  assert.equal(link.length, 1);
  assert.deepEqual(link[0].config.default.db_config, {
    host: "",
    port: 5432,
    user: "",
    password: "",
    database: "",
    auth_source: "",
  });
  assert.equal(link[0].config.default.ssh.enable, -1);
  assert.deepEqual(await f.app.store.get(p.id), p);
  assert.equal(f.sends(), 0);
});
