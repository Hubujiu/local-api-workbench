import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import { importIntoProject, snapshotPlan } from "../src/core.mjs";
import { createApp } from "../src/server.mjs";
import { saveModel } from "../public/model-edit.js";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";
import { nativeDirectoryFixture } from "./fixtures/apipost-directory.mjs";
const exporters = [exportApipost, exportApipostDirectory];
function fixture(url) {
  const d = modernApipostFixture();
  d.name = "Model Project";
  d.models = [
    {
      model_id: "types",
      model_type: "folder",
      name: "Types",
      sort: 0,
      description: "keep",
    },
    {
      model_id: "empty",
      model_type: "folder",
      name: "Empty",
      parent_id: "types",
    },
    {
      model_id: "a",
      model_type: "model",
      name: "A",
      parent_id: "types",
      sort: 0,
      schema: {
        type: "object",
        $defs: { leaf: { type: "string" } },
        properties: {
          name: { $ref: "#/$defs/leaf" },
          next: { $ref: "b" },
          self: { $ref: "a" },
        },
        example: { $ref: "https://literal.invalid", ref: "b" },
      },
    },
    {
      model_id: "b",
      model_type: "model",
      name: "B",
      schema: { type: "object", properties: { back: { $ref: "a" } } },
    },
  ];
  d.apis = d.apis.filter(
    (n) => n.target_type === "folder" || n.target_id === "api",
  );
  const api = d.apis.find((n) => n.target_type === "api");
  api.url = url;
  api.method = "POST";
  api.request.body = {
    mode: "json",
    raw: '{"name":"雪"}',
    raw_schema: { $ref: "a" },
    parameter: [],
    raw_parameter: [],
  };
  api.request.pre_tasks = [];
  api.request.post_tasks = [];
  api.response = {
    example: [
      {
        example_id: "example",
        raw: "{}",
        raw_parameter: [],
        headers: [
          { key: "content-type", value: "application/json", is_checked: 1 },
        ],
        expect: {
          name: "Response",
          code: "200",
          content_type: "json",
          schema: { $ref: "b" },
        },
      },
    ],
  };
  return d;
}
function verify(p) {
  const a = p.dictionary.find((m) => m.name === "Model Project / A"),
    b = p.dictionary.find((m) => m.name === "Model Project / B");
  assert(a && b);
  assert.deepEqual(a.schema, p.openapiComponents.schemas[a.id]);
  assert.equal(a.schema.properties.next.$ref, "#/components/schemas/" + b.id);
  assert.equal(a.schema.properties.self.$ref, "#/components/schemas/" + a.id);
  assert.equal(
    a.schema.properties.name.$ref,
    "#/components/schemas/" + a.id + "/$defs/leaf",
  );
  assert.equal(b.schema.properties.back.$ref, "#/components/schemas/" + a.id);
  assert.equal(a.schema.properties.edited.type, "boolean");
  assert.deepEqual(a.schema.example, {
    $ref: "https://literal.invalid",
    ref: "b",
  });
  assert.equal(p.requests[0].schema.$ref, "#/components/schemas/" + a.id);
  assert.equal(
    p.requests[0].responses[0].schema.$ref,
    "#/components/schemas/" + b.id,
  );
  assert.equal(
    p.modelFolders.find((f) => f.name === "Empty").parentId,
    p.modelFolders.find((f) => f.name === "Types").id,
  );
  assert.equal(a.folderId, p.modelFolders.find((f) => f.name === "Types").id);
  assert.equal(a.sort, 0);
}
test("empty model folders are preserved rather than silently discarded", () => {
  const p = {
      id: "p",
      name: "P",
      requests: [],
      environments: [{ id: "e", name: "E", variables: {} }],
      settings: {},
      dictionary: [],
      modelFolders: [{ id: "f", name: "Empty", sort: 0, description: "keep" }],
    },
    before = structuredClone(p);
  for (const exporter of exporters) {
    const q = {
      id: "q",
      name: "P",
      requests: [],
      environments: [],
      settings: {},
    };
    importIntoProject(q, exporter(p));
    assert.deepEqual(
      q.modelFolders.map(({ id, ...f }) => f),
      [{ name: "Empty", parentId: "", description: "keep", sort: 0 }],
    );
  }
  assert.deepEqual(p, before);
});
test("static reusable graph and request/response links survive editing, owner dual-format double roundtrip, HTTP, restore and restart", async (t) => {
  const hits = [];
  const server = http.createServer((q, r) => {
    let body = "";
    q.on("data", (c) => (body += c));
    q.on("end", () => {
      hits.push(body);
      r.setHeader("content-type", "application/json");
      r.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const root = await mkdtemp(path.join(os.tmpdir(), "model-export-"));
  let app = await createApp({ root, port: 0 });
  const stop = async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
  };
  t.after(async () => {
    await stop();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const call = async (route, method = "GET", body, status = 200) => {
    const r = await fetch(app.url + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const v = await r.json();
    assert.equal(r.status, status, JSON.stringify(v));
    return v;
  };
  const other = await app.store.create("other"),
    untouched = await app.store.get(other.id);
  for (const kind of ["json", "directory"]) {
    const native = fixture(`http://127.0.0.1:${server.address().port}/echo`),
      document = kind === "json" ? native : nativeDirectoryFixture(native),
      original = structuredClone(document);
    const p = await app.store.create("Model Project");
    let current = await call(`/api/projects/${p.id}/import`, "POST", {
      document,
    });
    assert.deepEqual(document, original);
    const index = current.dictionary.findIndex(
        (m) => m.name === "Model Project / A",
      ),
      a = current.dictionary[index];
    const schema = structuredClone(a.schema);
    schema.properties.edited = { type: "boolean" };
    saveModel(current, index, { name: a.name, schema }, "not-used");
    await call(`/api/projects/${p.id}`, "PUT", current);
    current = await app.store.get(p.id);
    verify(current);
    const before = structuredClone(current);
    for (const format of ["apipost", "apipost-directory"]) {
      const route = `/api/projects/${p.id}/export?format=${format}`;
      assert.equal((await fetch(app.url + route)).status, 403);
      let output = await call(route);
      let target;
      for (let generation = 0; generation < 2; generation++) {
        target = await app.store.create("Model Project");
        target = await call(`/api/projects/${target.id}/import`, "POST", {
          document: output,
        });
        verify(target);
        const plan = await call(`/api/projects/${target.id}/plans`, "POST", {
          steps: [{ request: target.requests[0] }],
        });
        const run = await call(`/api/projects/${target.id}/run`, "POST", {
          planId: plan.id,
        });
        assert.equal(run.status, "passed", JSON.stringify(run));
        assert.equal(hits.at(-1), '{"name":"雪"}');
        // Plans are an execution archive; this test exports definitions, not the plan.
        const saved = await app.store.get(target.id);
        saved.plans = [];
        await app.store.save(saved);
        output = await call(
          `/api/projects/${target.id}/export?format=${format}`,
        );
      }
      const backup = await call(`/api/projects/${target.id}/export`);
      const restored = await call(
        "/api/restore",
        "POST",
        { document: backup },
        201,
      );
      await stop();
      app = await createApp({ root, port: 0 });
      const disk = await app.store.get(restored.id);
      verify(disk);
      assert.deepEqual(disk.dictionary, backup.dictionary);
      assert.deepEqual(disk.openapiComponents, backup.openapiComponents);
    }
    assert.deepEqual(await app.store.get(p.id), before);
  }
  assert.deepEqual(await app.store.get(other.id), untouched);
});
test("unsupported model graphs and naming are rejected atomically", () => {
  const p = {
    id: "p",
    name: "Model Project",
    requests: [],
    environments: [],
    settings: {},
  };
  importIntoProject(p, fixture("http://127.0.0.1/unused"));
  const changes = [
    (q) => (q.name = "Different destination"),
    (q) => (q.dictionary[0].name = "Arbitrary edited label"),
    (q) => (q.dictionary[0].extra = true),
    (q) => (q.openapiComponents.schemas.extra = {}),
    (q) => (q.dictionary[0].schema = { type: "number" }),
    (q) => (q.openapiComponents.securitySchemes = { x: {} }),
    (q) => (q.modelFolders[0].extra = "lost"),
    (q) => (q.models = [{ id: "history" }]),
    (q) => {
      const a = q.dictionary[0];
      a.schema = { $dynamicRef: "#x" };
      q.openapiComponents.schemas[a.id] = a.schema;
    },
    (q) => {
      const a = q.dictionary[0];
      a.schema = { $ref: "https://external.invalid/schema" };
      q.openapiComponents.schemas[a.id] = a.schema;
    },
    (q) =>
      (q.requests[0].schema = {
        $ref: "#/components/schemas/" + q.dictionary[1].id + "/properties/back",
      }),
    (q) => (q.requests[0].schema = { $ref: "#/components/schemas/missing" }),
  ];
  for (const change of changes) {
    const q = structuredClone(p);
    change(q);
    const before = structuredClone(q);
    for (const exporter of exporters) assert.throws(() => exporter(q));
    assert.deepEqual(q, before);
  }
});

test("boolean models remain definitions while direct API booleans reject before normalization", () => {
  const p = {
    id: "p",
    name: "Model Project",
    requests: [],
    environments: [],
    settings: {},
  };
  const source = fixture("http://127.0.0.1/unused");
  source.models.push({
    model_id: "never",
    model_type: "model",
    name: "Never",
    schema: false,
  });
  source.apis.find((x) => x.target_type === "api").request.body.raw_schema = {
    $ref: "never",
  };
  importIntoProject(p, source);
  for (const exporter of exporters) {
    const q = {
      id: "q",
      name: "Model Project",
      requests: [],
      environments: [],
      settings: {},
    };
    importIntoProject(q, exporter(p));
    const m = q.dictionary.find((x) => x.name === "Model Project / Never");
    assert.equal(m.schema, false);
    assert.equal(q.openapiComponents.schemas[m.id], false);
    assert.equal(q.requests[0].schema.$ref, "#/components/schemas/" + m.id);
  }
  for (const value of [false, true]) {
    const q = structuredClone(p);
    q.requests[0].schema = value;
    for (const exporter of exporters)
      assert.throws(() => exporter(q), /直接布尔schema/);
  }
});

test("explicit preserve names survives project renames, both formats and frozen directory snapshots without changing defaults", () => {
  const native = fixture("http://127.0.0.1/unused");
  native.models.find((m) => m.model_id === "a").display_name =
    "雪 / arbitrary A";
  native.models.find((m) => m.model_id === "b").name = "Other Source / B";
  native.modelNameMode = "preserve"; // Untrusted file cannot opt in.
  const fresh = (name) => ({
    id: name,
    name,
    requests: [],
    environments: [],
    settings: {},
  });
  const legacy = fresh("Model Project");
  assert.throws(() => importIntoProject(legacy, native), /modelNameMode/);
  delete native.modelNameMode;
  importIntoProject(legacy, native);
  assert.equal(legacy.dictionary[0].name, "Model Project / 雪 / arbitrary A");
  const p = fresh("Renamed project");
  importIntoProject(p, native, { modelNameMode: "preserve" });
  const names = p.dictionary.map((m) => m.name);
  assert.deepEqual(names, ["雪 / arbitrary A", "Other Source / B"]);
  const before = structuredClone(p);
  for (const exporter of exporters) {
    assert.throws(() => exporter(p), /名称空间/);
    let doc = exporter(p, { modelNameMode: "preserve" });
    for (let generation = 0; generation < 2; generation++) {
      const target = fresh("Changed " + generation);
      importIntoProject(target, doc, { modelNameMode: "preserve" });
      assert.deepEqual(
        target.dictionary.map((m) => m.name),
        names,
      );
      assert.equal(
        target.requests[0].schema.$ref,
        "#/components/schemas/" + target.dictionary[0].id,
      );
      assert.equal(
        target.dictionary[0].schema.properties.next.$ref,
        "#/components/schemas/" + target.dictionary[1].id,
      );
      assert.equal(target.modelFolders.length, 2);
      doc = exporter(target, { modelNameMode: "preserve" });
    }
  }
  assert.deepEqual(p, before);
  const planned = structuredClone(p);
  planned.plans = [
    snapshotPlan({
      id: "plan",
      name: "Frozen",
      environmentId: p.environments[0].id,
      statusPolicy: "strict200",
      steps: [{ id: "step", request: p.requests[0] }],
    }),
  ];
  const frozenOutput = exportApipostDirectory(planned, {
    modelNameMode: "preserve",
  });
  const frozenTarget = fresh("Frozen renamed");
  importIntoProject(frozenTarget, frozenOutput, { modelNameMode: "preserve" });
  assert.deepEqual(
    frozenTarget.dictionary.map((m) => m.name),
    names,
  );
  assert.equal(
    frozenTarget.plans[0].steps[0].request.schema.$ref,
    frozenTarget.requests[0].schema.$ref,
  );
  for (const mode of [null, "", "other", false]) {
    assert.throws(
      () => importIntoProject(p, native, { modelNameMode: mode }),
      /modelNameMode/,
    );
    assert.throws(
      () => exportApipost(p, { modelNameMode: mode }),
      /modelNameMode/,
    );
  }
  assert.throws(
    () =>
      importIntoProject(
        p,
        { openapi: "3.0.0", paths: {} },
        { modelNameMode: "namespaced" },
      ),
    /modelNameMode/,
  );
  for (const value of ["x".repeat(201), "\ud800", 7]) {
    const invalid = structuredClone(native);
    invalid.models.find((m) => m.model_id === "a").display_name = value;
    assert.throws(
      () => importIntoProject(p, invalid, { modelNameMode: "preserve" }),
      /模型名称/,
    );
  }
  const duplicate = structuredClone(native);
  duplicate.models.find((m) => m.model_id === "b").name = "雪 / arbitrary A";
  assert.throws(
    () =>
      importIntoProject(fresh("Q"), duplicate, { modelNameMode: "preserve" }),
    /名称冲突/,
  );
  assert.deepEqual(p, before);
});

test("owner preserve option is explicit, atomic, persisted through backup/restart and isolated", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "model-name-mode-"));
  let app = await createApp({ root, port: 0 });
  const stop = async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
  };
  t.after(async () => {
    await stop();
    await rm(root, { recursive: true, force: true });
  });
  const call = async (route, method = "GET", body, expected = 200) => {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    return value;
  };
  const p = await app.store.create("Destination"),
    other = await app.store.create("Other");
  const untouched = await app.store.get(other.id);
  const native = fixture("http://127.0.0.1/unused");
  native.models.find((m) => m.model_id === "a").name = "雪 / unprefixed";
  native.models.find((m) => m.model_id === "b").name = "x".repeat(200);
  const source = structuredClone(native);
  let current = await call(`/api/projects/${p.id}/import`, "POST", {
    document: native,
    modelNameMode: "preserve",
  });
  current.name = "Owner renamed";
  await call(`/api/projects/${p.id}`, "PUT", current);
  current = await app.store.get(p.id);
  const names = current.dictionary.map((m) => m.name);
  for (const format of ["apipost", "apipost-directory"]) {
    const route = `/api/projects/${p.id}/export?format=${format}`;
    await call(route, "GET", undefined, 400);
    let document = await call(route + "&modelNameMode=preserve");
    for (let generation = 0; generation < 2; generation++) {
      const target = await app.store.create("Arbitrary " + generation);
      const imported = await call(`/api/projects/${target.id}/import`, "POST", {
        document,
        modelNameMode: "preserve",
      });
      assert.deepEqual(
        imported.dictionary.map((m) => m.name),
        names,
      );
      document = await call(
        `/api/projects/${target.id}/export?format=${format}&modelNameMode=preserve`,
      );
    }
    await call(
      route + "&modelNameMode=preserve&modelNameMode=namespaced",
      "GET",
      undefined,
      400,
    );
    await call(route + "&modelNameMode=invalid", "GET", undefined, 400);
  }
  for (const format of ["openapi", "backup", ""])
    await call(
      `/api/projects/${p.id}/export?format=${format}&modelNameMode=preserve`,
      "GET",
      undefined,
      400,
    );
  for (const mode of [null, "", false, "bad"])
    await call(
      `/api/projects/${p.id}/import`,
      "POST",
      { document: native, modelNameMode: mode },
      400,
    );
  await call(
    `/api/projects/${p.id}/import`,
    "POST",
    { document: { openapi: "3.0.0", paths: {} }, modelNameMode: "preserve" },
    400,
  );
  assert.deepEqual(await app.store.get(p.id), current);
  const backup = await call(`/api/projects/${p.id}/export`);
  assert.equal(backup.settings.modelNameMode, undefined);
  const restored = await call(
    "/api/restore",
    "POST",
    { document: backup },
    201,
  );
  await stop();
  app = await createApp({ root, port: 0 });
  const disk = await app.store.get(restored.id);
  assert.deepEqual(disk.dictionary, backup.dictionary);
  assert.deepEqual(disk.openapiComponents, backup.openapiComponents);
  assert.deepEqual(await app.store.get(other.id), untouched);
  assert.deepEqual(native, source);
});
