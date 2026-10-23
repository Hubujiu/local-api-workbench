import test from "node:test";
import assert from "node:assert/strict";
import { assembleApipostDirectory } from "../src/apipost-directory.mjs";
import { nativeDirectoryFixture } from "./fixtures/apipost-directory.mjs";
test("native JSON directory assembly preserves supported records without source mutation", () => {
  const source = nativeDirectoryFixture(),
    before = structuredClone(source);
  const d = assembleApipostDirectory(source);
  assert.equal(d.apis.length, 2);
  assert.equal(d.apis[1].request.header.parameter[0].value, "{{shared}}");
  assert.equal(d.global.envs[0].env_var_list.id.current_value, "43");
  assert.equal(d.global.marks[0].name, "Ready");
  assert.deepEqual(source, before);
});
test("native directory rejects traversal, duplicate paths, missing or stale indexes and unknown data", () => {
  for (const change of [
    (d) => d.files.push({ path: "../project.json", text: "{}" }),
    (d) => d.files.push({ ...d.files[0] }),
    (d) => d.files.push({ path: "settings/unknown.json", text: "{}" }),
    (d) =>
      d.files.splice(
        d.files.findIndex((f) => f.path === "apis/api.json"),
        1,
      ),
    (d) => {
      const f = d.files.find((f) => f.path === "apis/index.json"),
        x = JSON.parse(f.text);
      x.project_id = "other";
      f.text = JSON.stringify(x);
    },
    (d) => {
      const f = d.files.find((f) => f.path === "apis/index.json"),
        x = JSON.parse(f.text);
      x.items[1].name = "stale";
      f.text = JSON.stringify(x);
    },
    (d) => d.files.push({ path: "apis/orphan.json", text: "{}" }),
    (d) => {
      const f = d.files.find((f) => f.path === "apis/api.json"),
        x = JSON.parse(f.text);
      x.data.target_id = "other";
      f.text = JSON.stringify(x);
    },
  ]) {
    const source = nativeDirectoryFixture();
    change(source);
    const before = structuredClone(source);
    assert.throws(() => assembleApipostDirectory(source));
    assert.deepEqual(source, before);
  }
});

test("directory selection rejects unknown files and aggregate size before reading bytes", async () => {
  const { selectedDirectoryDocument } = await import(
    "../public/apipost-directory-input.js"
  );
  let reads = 0;
  const file = (path, text) => ({
    webkitRelativePath: "原项目/" + path,
    size: Buffer.byteLength(text),
    arrayBuffer: async () => {
      reads++;
      return new TextEncoder().encode(text).buffer;
    },
  });
  const doc = nativeDirectoryFixture(),
    chosen = doc.files.map((f) => file(f.path, f.text));
  assert.deepEqual(await selectedDirectoryDocument(chosen), doc);
  reads = 0;
  await assert.rejects(
    () => selectedDirectoryDocument([...chosen, file("unknown.json", "{}")]),
    /未支持/,
  );
  assert.equal(reads, 0);
  await assert.rejects(
    () => selectedDirectoryDocument([{ ...chosen[0], size: 4 * 1024 * 1024 }]),
    /4MiB/,
  );
  assert.equal(reads, 0);
  await assert.rejects(
    () =>
      selectedDirectoryDocument([
        {
          ...chosen[0],
          arrayBuffer: async () => new Uint8Array([255]).buffer,
          size: 1,
        },
      ]),
    /UTF-8/,
  );
  await assert.rejects(
    () =>
      selectedDirectoryDocument([
        chosen[0],
        { ...chosen[1], webkitRelativePath: "other/global_vars.json" },
      ]),
    /单个/,
  );
});

test("native JSON subset imports atomically and preserves environment resolution on real HTTP", async (t) => {
  const { importIntoProject, importDocument, interpolate } = await import(
    "../src/core.mjs"
  );
  const { modernApipostFixture } = await import(
    "./fixtures/apipost-modern.mjs"
  );
  const { resolveServiceRequest, environmentVariables } = await import(
    "../src/environments.mjs"
  );
  const { executeRequest } = await import("../src/runtime.mjs");
  const http = await import("node:http");
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, header: req.headers["x-test"] });
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const source = modernApipostFixture();
  source.global.envs[0].server_list[0].uri =
    "http://127.0.0.1:" + server.address().port;
  const document = nativeDirectoryFixture(source),
    original = structuredClone(document);
  const p = {
    requests: [],
    folders: [],
    environments: [],
    servers: [],
    settings: { statuses: [] },
    globalVariables: {},
  };
  importIntoProject(p, document);
  assert.equal(seen.length, 0);
  assert.equal(p.requests.length, 1);
  assert.match(p.requests[0].importNotes.join("\n"), /原版目录JSON子集/);
  const env = p.environments[0].id;
  await executeRequest(
    interpolate(
      resolveServiceRequest(p, p.requests[0], env),
      environmentVariables(p, env),
    ),
  );
  assert.deepEqual(seen, [{ url: "/items/43?q=one", header: "current" }]);
  assert.deepEqual(document, original);
  assert.throws(() => importDocument(document), /完整项目/);
  const bad = structuredClone(document);
  bad.files.find((f) => f.path === "settings/custom_funcs.json").text =
    '[{"func_name":"unsupported","func_body":"return text;"}]';
  const before = structuredClone(p);
  assert.throws(() => importIntoProject(p, bad), /custom_func/);
  assert.deepEqual(p, before);
});

test("native subset retains model and sample group links through existing atomic import", async () => {
  const { modernApipostFixture } = await import(
    "./fixtures/apipost-modern.mjs"
  );
  const { importIntoProject } = await import("../src/core.mjs");
  const d = modernApipostFixture();
  d.models = [
    {
      model_id: "model-group",
      model_type: "folder",
      name: "Models",
      parent_id: "0",
    },
    {
      model_id: "model",
      model_type: "model",
      name: "Value",
      parent_id: "model-group",
      schema: { type: "object", properties: { id: { type: "integer" } } },
    },
  ];
  d.samples = [
    {
      sample_id: "case-group",
      target_id: "api",
      parent_id: "0",
      type: "sample_group",
      name: "Cases",
    },
    {
      sample_id: "case",
      target_id: "api",
      parent_id: "case-group",
      type: "sample",
      name: "Saved case",
      method: "GET",
      url: "/sample",
      request: { auth: { type: "noauth" }, body: { mode: "none" } },
      response: { example: [] },
    },
  ];
  const p = {
    requests: [],
    folders: [],
    environments: [],
    servers: [],
    settings: { statuses: [] },
    globalVariables: {},
  };
  importIntoProject(p, nativeDirectoryFixture(d));
  assert.equal(p.modelFolders.length, 1);
  assert.equal(p.dictionary.length, 1);
  assert.equal(p.caseFolders.length, 1);
  assert.equal(p.cases.length, 1);
  assert.equal(p.cases[0].sourceRequestId, p.requests[0].id);
  assert.equal(p.cases[0].folderId, p.caseFolders[0].id);
});
