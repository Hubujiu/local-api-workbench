import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { importIntoProject, importDocument } from "../src/core.mjs";
import {
  resolveServiceRequest,
  environmentVariables,
} from "../src/environments.mjs";
import { executeRequest } from "../src/runtime.mjs";
import { interpolate } from "../src/core.mjs";
import { modernApipostFixture as fixture } from "./fixtures/apipost-modern.mjs";
const project = () => ({
  requests: [],
  folders: [],
  environments: [{ id: "existing", name: "Existing", variables: {} }],
  currentEnvironmentId: "existing",
  servers: [],
  globalVariables: {},
  settings: { statuses: [] },
});
test("modern export preserves wrapped parameters, environments, services, globals and response examples", async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, header: req.headers["x-test"] });
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const doc = fixture();
  doc.global.envs[0].server_list[0].uri =
    "http://127.0.0.1:" + server.address().port;
  doc.global.envs[0].env_var_list.id.description = "Identifier";
  doc.global.global_vars.shared.description = "Shared token";
  const p = project();
  const imported = importIntoProject(p, doc);
  assert.equal(imported.length, 1);
  assert.equal(p.currentEnvironmentId, "existing");
  assert.equal(p.environments.length, 2);
  assert.equal(p.requests[0].folder, "Group");
  assert.equal(p.requests[0].description, "preserved");
  assert.equal(p.requests[0].examples[0].body, '{"ok":true}');
  assert.equal(p.requests[0].statusId, p.settings.statuses[0].id);
  const env = p.environments.find((x) => x.id !== "existing");
  assert.deepEqual(env.variableDefinitions.id, {
    initialValue: "42",
    description: "Identifier",
  });
  assert.deepEqual(p.globalVariableDefinitions.shared, {
    initialValue: "global",
    description: "Shared token",
  });
  const request = interpolate(
    resolveServiceRequest(p, p.requests[0], env.id),
    environmentVariables(p, env.id),
  );
  const result = await executeRequest(request);
  assert.equal(result.status, 200);
  assert.deepEqual(seen, [{ url: "/items/43?q=one", header: "current" }]);
});
test("modern dependency and merge failures are atomic and request-only conversion refuses metadata loss", () => {
  for (const change of [
    (d) => d.models.push({ model_id: "unsupported" }),
    (d) =>
      d.apis[1].request.pre_tasks.push({ type: "script", value: "danger" }),
    (d) => d.global.attributes.push({ name: "unknown" }),
    (d) => (d.global.envs[0].server_list[0].server_id = "missing"),
  ]) {
    const d = fixture();
    change(d);
    const p = project(),
      before = structuredClone(p);
    assert.throws(() => importIntoProject(p, d));
    assert.deepEqual(p, before);
  }
  const p = project();
  p.globalVariables.shared = "conflict";
  const before = structuredClone(p);
  assert.throws(() => importIntoProject(p, fixture()), /冲突/);
  assert.deepEqual(p, before);
  assert.throws(() => importDocument(fixture()), /完整项目/);
  assert.throws(
    () => importIntoProject(project(), fixture(), { sync: true }),
    /同步/,
  );
});

test("modern inheritance is flattened explicitly and cyclic or ambiguous dependencies reject", () => {
  const doc = fixture();
  doc.global.global_param.header.parameter = [
    { key: "X-Global", value: "g" },
    { key: "X-Test", value: "global" },
  ];
  doc.apis[0].request.header = {
    parameter: [{ key: "X-Test", value: "folder" }],
  };
  doc.apis[1].request.header.parameter = [];
  const p = project();
  const [request] = importIntoProject(p, doc);
  assert.equal(request.headers.find((h) => h.key === "X-Test").value, "folder");
  assert.equal(request.headers.find((h) => h.key === "X-Global").value, "g");
  for (const mutate of [
    (d) => (d.apis[0].parent_id = "folder"),
    (d) => (d.apis[1].url = "//{{id}}/path"),
    (d) => (d.global.global_param.body.raw = "inherited"),
    (d) => (d.apis[1].request.post_tasks = [{ type: "script" }]),
    (d) => d.global.servers.push({ ...d.global.servers[0] }),
    (d) => (d.extraResource = { hidden: true }),
  ]) {
    const d = fixture();
    mutate(d);
    const target = project(),
      before = structuredClone(target);
    assert.throws(() => importIntoProject(target, d));
    assert.deepEqual(target, before);
  }
});

test("modern flat models preserve references and generate usable schemas without fetching remote resources", async () => {
  const { sampleProjectSchema } = await import("../src/mock-fields.mjs");
  const d = fixture();
  d.models = [
    {
      model_id: "user",
      model_type: "model",
      parent_id: "0",
      name: "User",
      description: "A fictional user",
      schema: {
        type: "object",
        properties: { id: { type: "integer", const: 7 } },
        required: ["id"],
      },
    },
  ];
  d.apis[1].request.body.raw_schema = { $ref: "#/definitions/user" };
  const p = project();
  importIntoProject(p, d);
  assert.equal(p.dictionary.length, 1);
  assert.deepEqual(sampleProjectSchema(p, p.requests[0].schema), { id: 7 });
  assert.match(p.requests[0].schema.$ref, /^#\/components\/schemas\/apipost-/);
  assert.equal(p.dictionary[0].schema.description, "A fictional user");
  for (const ref of ["https://example.test/schema", "#/definitions/missing"]) {
    const bad = fixture();
    bad.models = structuredClone(d.models);
    bad.apis[1].request.body.raw_schema = { $ref: ref };
    const target = project(),
      before = structuredClone(target);
    assert.throws(() => importIntoProject(target, bad));
    assert.deepEqual(target, before);
  }
  const custom = structuredClone(d);
  custom.models[0].schema["x-schema-refs"] = { bad: { $ref: "user" } };
  assert.throws(() => importIntoProject(project(), custom), /自定义/);
});

test("model-local pointers are rebased and conflicting reimports remain atomic", async () => {
  const { sampleProjectSchema } = await import("../src/mock-fields.mjs");
  const d = fixture();
  d.models = [
    {
      model_id: "local",
      model_type: "model",
      name: "Local",
      schema: {
        $defs: { Number: { const: 8 } },
        type: "object",
        properties: { n: { $ref: "#/$defs/Number" } },
      },
    },
  ];
  d.apis[1].request.body.raw_schema = { $ref: "local" };
  const p = project();
  importIntoProject(p, d);
  assert.deepEqual(sampleProjectSchema(p, p.requests[0].schema), { n: 8 });
  const before = structuredClone(p);
  d.models[0].schema.$defs.Number.const = 9;
  assert.throws(() => importIntoProject(p, d), /冲突/);
  assert.deepEqual(p, before);
});

test("modern import preserves literal reference-shaped examples end to end", async () => {
  const { sampleProjectSchema } = await import("../src/mock-fields.mjs");
  const d = fixture();
  const literal = {
    $ref: "https://example.invalid/data-only",
    ref: "example",
    nested: { APIPOST_REFS: { value: 1 } },
  };
  d.models = [
    {
      model_id: "literal",
      model_type: "model",
      name: "Literal",
      schema: { type: "object", example: literal },
    },
  ];
  d.apis[1].request.body.raw_schema = { $ref: "literal" };
  const p = project();
  importIntoProject(p, d);
  assert.deepEqual(p.dictionary[0].schema.example, literal);
  assert.deepEqual(sampleProjectSchema(p, p.requests[0].schema), literal);
});

test("modern import rejects conflicting initial variable definitions atomically", () => {
  const p = project();
  p.globalVariables.shared = "current";
  p.globalVariableDefinitions = {
    shared: { initialValue: "different", description: "" },
  };
  const before = structuredClone(p);
  assert.throws(() => importIntoProject(p, fixture()), /初始定义冲突/);
  assert.deepEqual(p, before);
});

test("modern explicit empty response examples survive import, Mock selection and OpenAPI roundtrip", async () => {
  const { selectMockResponse } = await import("../src/mock.mjs");
  const { exportOpenAPI } = await import("../src/core.mjs");
  const doc = fixture(),
    p = project();
  doc.apis[1].url = "https://fixture.example.test/empty";
  doc.apis[1].response.example = [
    {
      raw: "",
      expect: { code: "204", content_type: "text", name: "No content" },
    },
    {
      raw: "  \n",
      expect: { code: "200", content_type: "text", name: "Whitespace" },
    },
    { expect: { code: "404", content_type: "text", name: "Definition only" } },
  ];
  const before = structuredClone(doc);
  importIntoProject(p, doc);
  assert.deepEqual(
    p.requests[0].examples.map((x) => [x.name, x.status, x.body]),
    [
      ["No content", 204, ""],
      ["Whitespace", 200, "  \n"],
    ],
  );
  assert.equal(selectMockResponse(p.requests[0], {}).body, "");
  const exported = exportOpenAPI(p),
    roundtrip = importDocument(exported);
  assert.ok(
    roundtrip[0].examples.some((x) => x.status === 204 && x.body === ""),
  );
  assert.ok(
    roundtrip[0].examples.some((x) => x.status === 200 && x.body === "  \n"),
  );
  assert.deepEqual(doc, before);
});

test("modern disabled numeric Mock allowlist flag is not mistaken for enabled access control", () => {
  const doc = fixture(),
    p = project();
  doc.apis[1].mock_ip_white_list_enable = -1;
  importIntoProject(p, doc);
  assert.equal(p.requests.length, 1);
  for (const enabled of [1, true, "-1", 2]) {
    const invalid = fixture(),
      target = project(),
      before = structuredClone(target);
    invalid.apis[1].mock_ip_white_list_enable = enabled;
    assert.throws(() => importIntoProject(target, invalid), /IP白名单/);
    assert.deepEqual(target, before);
  }
});

test("modern omit-equals numeric sentinel cannot silently change an empty query flag", () => {
  const doc = fixture();
  doc.apis[1].request.query.query_add_equal = -1;
  doc.apis[1].request.query.parameter = [
    { key: "flag", value: "", is_checked: 1 },
  ];
  const p = project(),
    before = structuredClone(p);
  assert.throws(() => importIntoProject(p, doc), /省略等号/);
  assert.deepEqual(p, before);
  for (const value of ["value", 0, false]) {
    doc.apis[1].request.query.parameter[0].value = value;
    const target = project();
    importIntoProject(target, doc);
    assert.equal(target.requests[0].query[0].value, value);
  }
});

test("modern inheritance replaces parent name groups without losing duplicate child parameters", async (t) => {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ url: req.url, header: req.headers["x-repeat"] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const doc = fixture(),
    p = project();
  doc.global.envs[0].server_list[0].uri =
    "http://127.0.0.1:" + server.address().port;
  doc.global.global_param.header.parameter = [
    { key: "X-Repeat", value: "global", is_checked: 1 },
  ];
  doc.apis[0].request.header = {
    parameter: [{ key: "X-Repeat", value: "folder", is_checked: 1 }],
  };
  doc.apis[1].request.header.parameter = [
    { key: "X-Repeat", value: "first", is_checked: 1 },
    { key: "x-repeat", value: "second", is_checked: 1 },
    { key: "X-Repeat", value: "hidden", is_checked: -1 },
  ];
  doc.apis[0].request.query = {
    parameter: [{ key: "q", value: "parent", is_checked: 1 }],
  };
  doc.apis[1].request.query.parameter = [
    { key: "q", value: "first", is_checked: 1 },
    { key: "middle", value: "keep", is_checked: 1 },
    { key: "q", value: "second", is_checked: 1 },
  ];
  const original = structuredClone(doc);
  importIntoProject(p, doc);
  assert.deepEqual(
    p.requests[0].headers.map((x) => x.value),
    ["first", "second", "hidden"],
  );
  assert.deepEqual(
    p.requests[0].query.map((x) => [x.key, x.value]),
    [
      ["q", "first"],
      ["middle", "keep"],
      ["q", "second"],
    ],
  );
  const env = p.environments.find((x) => x.id !== "existing");
  const request = interpolate(
    resolveServiceRequest(p, p.requests[0], env.id),
    environmentVariables(p, env.id),
  );
  const wire = JSON.parse((await executeRequest(request)).body);
  assert.equal(wire.header, "first, second");
  assert.deepEqual(
    new URL(wire.url, "http://localhost").searchParams.getAll("q"),
    ["first", "second"],
  );
  assert.deepEqual(doc, original);
});
