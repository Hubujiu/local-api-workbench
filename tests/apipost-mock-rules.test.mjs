import test from "node:test";
import assert from "node:assert/strict";
import { importIntoProject } from "../src/core.mjs";
import {
  createFieldSampler,
  normalizeMockFieldRules,
} from "../src/mock-fields.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";
const rule = (extra = {}) => ({
  mock_custom_rule_id: "count",
  field_type: "integer",
  match_type: "exact",
  match_rule: "Count",
  match_case: -1,
  mock_type: 1,
  mock_rule_content: "@natural(7,7)",
  intro: "Count rule",
  ...extra,
});
const project = () => ({
  requests: [],
  folders: [],
  environments: [],
  servers: [],
  settings: { statuses: [] },
  globalVariables: {},
});
test("bounded native numeric Mock rules import passively with exact names, types and constraint precedence", () => {
  const doc = modernApipostFixture();
  doc.global.mock_custom_rules = [
    rule(),
    rule({
      mock_custom_rule_id: "number",
      field_type: "number",
      match_rule: "Amount",
      match_case: 1,
      mock_rule_content: "@integer(9,9)",
    }),
  ];
  const p = project(),
    original = structuredClone(doc);
  importIntoProject(p, doc);
  const sample = createFieldSampler(p.settings);
  assert.equal(sample("count", { type: "integer" }), 7);
  assert.equal(sample("counter", { type: "integer" }), undefined);
  assert.equal(sample("Amount", { type: "number" }), 9);
  assert.equal(sample("amount", { type: "number" }), undefined);
  assert.equal(sample("Amount", { type: "integer" }), undefined);
  assert.equal(sample("Count", { type: "integer", minimum: 1 }), undefined);
  assert.equal(sample("Count", { type: "integer", maximum: 100 }), undefined);
  for (const constraint of [
    { exclusiveMinimum: 1 },
    { exclusiveMaximum: 10 },
    { multipleOf: 2 },
  ])
    assert.throws(
      () => sample("Count", { type: "integer", ...constraint }),
      /暂不支持/,
    );
  assert.deepEqual(doc, original);
  assert.deepEqual(
    normalizeMockFieldRules(p.settings.mockFieldRules),
    p.settings.mockFieldRules,
  );
  const previous = structuredClone(p.settings.mockFieldRules);
  importIntoProject(p, doc);
  assert.deepEqual(p.settings.mockFieldRules, previous);
});
test("unsupported native Mock rules fail atomically rather than silently changing semantics", () => {
  for (const extra of [
    { match_type: "wildcard", match_rule: "count?" },
    { mock_type: 2 },
    { field_type: "string" },
    { match_rule: "count*" },
    { mock_rule_content: "@natural(0,1e20)" },
    { match_case: 0 },
    { extra: "unknown" },
  ]) {
    const p = project(),
      before = structuredClone(p),
      doc = modernApipostFixture();
    doc.global.mock_custom_rules = [rule(extra)];
    assert.throws(() => importIntoProject(p, doc));
    assert.deepEqual(p, before);
  }
});

test("native numeric rules retain ordering, source identity and explicit examples across storage and HTTP", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createApp } = await import("../src/server.mjs");
  const { nativeDirectoryFixture } = await import(
    "./fixtures/apipost-directory.mjs"
  );
  const root = await mkdtemp(join(tmpdir(), "native-mock-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("Native numeric rules");
  const doc = modernApipostFixture();
  doc.global.mock_custom_rules = [
    rule(),
    rule({ mock_custom_rule_id: "second", mock_rule_content: "@natural(8,8)" }),
    rule({
      mock_custom_rule_id: "total",
      match_type: "wildcard",
      match_rule: "{total*,sum}",
      mock_rule_content: "@natural(3,3)",
    }),
  ];
  importIntoProject(p, nativeDirectoryFixture(doc));
  const schema = {
    type: "object",
    properties: {
      count: { type: "integer" },
      explicit: { type: "integer", example: 99 },
      totalCount: { type: "integer" },
      Count: { type: "integer", minimum: 3, maximum: 3 },
    },
  };
  p.requests = [
    {
      id: "auto",
      name: "auto",
      url: app.url + "/mock/" + p.id + "/auto",
      responses: [{ status: "200", contentType: "application/json", schema }],
    },
  ];
  await app.store.save(p);
  const restored = await app.store.get(p.id);
  assert.deepEqual(restored.settings.mockFieldRules, p.settings.mockFieldRules);
  const preview = await fetch(app.url + "/api/projects/" + p.id + "/sample", {
    method: "POST",
    headers: { "x-local-token": app.token, "content-type": "application/json" },
    body: JSON.stringify({ schema }),
  });
  assert.equal(preview.status, 200);
  assert.deepEqual((await preview.json()).sample, {
    count: 7,
    explicit: 99,
    totalCount: 3,
    Count: 3,
  });
  assert.deepEqual(await (await fetch(p.requests[0].url)).json(), {
    count: 7,
    explicit: 99,
    totalCount: 3,
    Count: 3,
  });
  const conflict = structuredClone(doc);
  conflict.global.mock_custom_rules[0].mock_rule_content = "@natural(9,9)";
  const before = structuredClone(restored);
  assert.throws(() => importIntoProject(restored, conflict), /冲突/);
  assert.deepEqual(restored, before);
  for (const change of [
    { pattern: "*" },
    { type: "any" },
    { mock: "@float(1,2)" },
    { apipostSource: { projectId: "x", id: "a", unknown: true } },
  ])
    assert.throws(() =>
      normalizeMockFieldRules([{ ...p.settings.mockFieldRules[0], ...change }]),
    );
});

test("native star-only wildcard rules preserve path and dot-name boundaries", () => {
  const doc = modernApipostFixture();
  doc.global.mock_custom_rules = [
    rule({ match_type: "wildcard", match_rule: "*count*" }),
  ];
  const p = project();
  importIntoProject(p, doc);
  const sample = createFieldSampler(p.settings);
  for (const name of ["count", "itemCount", "count_total", "项目count"])
    assert.equal(sample(name, { type: "integer" }), 7);
  for (const name of [".count", "a/count", "uncounted/path", "other"])
    assert.equal(sample(name, { type: "integer" }), undefined);
  assert.throws(() => sample("a\\count", { type: "integer" }), /反斜杠/);
  const all = modernApipostFixture();
  all.global.mock_custom_rules = [
    rule({ match_type: "wildcard", match_rule: "*" }),
  ];
  const q = project();
  importIntoProject(q, all);
  assert.equal(createFieldSampler(q.settings)("😀", { type: "integer" }), 7);
  for (const match_rule of [
    "a?",
    "[ab]",
    "{a,{b,c}}",
    "**",
    "a/**",
    "!count",
    ".*",
  ]) {
    const bad = modernApipostFixture();
    bad.global.mock_custom_rules = [
      rule({ match_type: "wildcard", match_rule }),
    ];
    assert.throws(() => importIntoProject(project(), bad));
  }
});

test("native bounded brace alternatives expand in order without admitting ranges or nested globs", () => {
  const doc = modernApipostFixture();
  doc.global.mock_custom_rules = [
    rule({ match_type: "wildcard", match_rule: "{id,num,*count}" }),
  ];
  const p = project();
  importIntoProject(p, doc);
  const sample = createFieldSampler(p.settings);
  for (const name of ["id", "NUM", "count", "total_count"])
    assert.equal(sample(name, { type: "integer" }), 7);
  for (const name of [".id", "folder/id", "number"])
    assert.equal(sample(name, { type: "integer" }), undefined);
  for (const match_rule of [
    "{id}",
    "{1..3}",
    "{,id}",
    "{id,}",
    "{a,{b,c}}",
    "{a,b},c",
    "{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}",
    "{.id,num}",
    "*{*,id}",
  ]) {
    const bad = modernApipostFixture();
    bad.global.mock_custom_rules = [
      rule({ match_type: "wildcard", match_rule }),
    ];
    const target = project(),
      before = structuredClone(target);
    assert.throws(() => importIntoProject(target, bad));
    assert.deepEqual(target, before);
  }
});
