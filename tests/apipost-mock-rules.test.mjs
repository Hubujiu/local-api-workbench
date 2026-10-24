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
    { match_type: "wildcard", match_rule: "count[[:digit:]]" },
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
      match_rule: "{total*,su?,item_[0-9]}",
      mock_rule_content: "@natural(3,3)",
    }),
  ];
  doc.global.mock_custom_rules.push(
    rule({
      mock_custom_rule_id: "price",
      field_type: "number",
      match_rule: "price",
      mock_rule_content: "@float(6,6,0,0)",
    }),
  );
  importIntoProject(p, nativeDirectoryFixture(doc));
  const schema = {
    type: "object",
    properties: {
      count: { type: "integer" },
      explicit: { type: "integer", example: 99 },
      totalCount: { type: "integer" },
      sum: { type: "integer" },
      item_5: { type: "integer" },
      price: { type: "number" },
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
    sum: 3,
    item_5: 3,
    price: 6,
    Count: 3,
  });
  assert.deepEqual(await (await fetch(p.requests[0].url)).json(), {
    count: 7,
    explicit: 99,
    totalCount: 3,
    sum: 3,
    item_5: 3,
    price: 6,
    Count: 3,
  });
  const current = await app.store.get(p.id);
  current.settings.mockFieldRules.find(
    (rule) => rule.pattern === "price",
  ).mock = "@float(3,3,2,2)";
  await app.store.save(current);
  const actualFloat = (await (await fetch(p.requests[0].url)).json()).price;
  assert(actualFloat > 3 && actualFloat < 4);
  assert.match(String(actualFloat), /^3\.[0-9][1-9]$/);
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
    "a[^ab]",
    "[[:digit:]]",
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

test("native question wildcards count UTF-16 units without changing Local API glob semantics", async () => {
  const { matchesFieldPattern } = await import("../src/mock-fields.mjs");
  const sampler = (pattern) => {
    const doc = modernApipostFixture();
    doc.global.mock_custom_rules = [
      rule({ match_type: "wildcard", match_rule: pattern }),
    ];
    const p = project();
    importIntoProject(p, doc);
    return createFieldSampler(p.settings);
  };
  const one = sampler("?"),
    two = sampler("??"),
    mixed = sampler("{item_?,name??}");
  assert.equal(one("中", { type: "integer" }), 7);
  assert.equal(one("😀", { type: "integer" }), undefined);
  assert.equal(two("😀", { type: "integer" }), 7);
  assert.equal(mixed("item_中", { type: "integer" }), 7);
  assert.equal(mixed("item_😀", { type: "integer" }), undefined);
  assert.equal(mixed("name😀", { type: "integer" }), 7);
  assert.equal(two(".x", { type: "integer" }), undefined);
  assert.equal(two("a/", { type: "integer" }), undefined);
  assert(
    matchesFieldPattern("?", "😀"),
    "existing Local API globs still use Unicode code points",
  );
});

test("native bounded ASCII classes preserve ranges, negation and UTF-16 matching", () => {
  const sampler = (pattern) => {
    const doc = modernApipostFixture();
    doc.global.mock_custom_rules = [
      rule({ match_type: "wildcard", match_rule: pattern, match_case: 1 }),
    ];
    const p = project();
    importIntoProject(p, doc);
    return createFieldSampler(p.settings);
  };
  const digits = sampler("item_[0-9]"),
    letters = sampler("{[abc],[!0-9]}");
  assert.equal(digits("item_5", { type: "integer" }), 7);
  assert.equal(digits("item_٥", { type: "integer" }), undefined);
  assert.equal(letters("b", { type: "integer" }), 7);
  assert.equal(letters("中", { type: "integer" }), 7);
  assert.equal(letters("7", { type: "integer" }), undefined);
  assert.equal(letters("😀", { type: "integer" }), undefined);
  assert.equal(sampler("[!a][!a]")("😀", { type: "integer" }), 7);
  assert.equal(sampler("[!a]")(".", { type: "integer" }), undefined);
  for (const pattern of ["[a-z]", "[A-Z]"])
    assert.equal(
      sampler(pattern)(pattern === "[a-z]" ? "m" : "M", { type: "integer" }),
      7,
    );
  for (const match_rule of [
    "[z-a]",
    "[A-z]",
    "[[:digit:]]",
    "[^a]",
    "[.]",
    "[a,b]",
    "[]",
    "[a-]",
    "[\\\\a]",
    "[a[b]]",
  ]) {
    const doc = modernApipostFixture();
    doc.global.mock_custom_rules = [
      rule({ match_type: "wildcard", match_rule }),
    ];
    assert.throws(() => importIntoProject(project(), doc));
  }
});

test("native float rules use integer-part bounds and a nonzero last fractional digit", () => {
  const make = (expression) => {
    const doc = modernApipostFixture();
    doc.global.mock_custom_rules = [
      rule({ field_type: "number", mock_rule_content: expression }),
    ];
    const p = project();
    importIntoProject(p, doc);
    p.settings.mockSeed = 42;
    return createFieldSampler(p.settings);
  };
  assert.equal(
    createFieldSampler({
      mockFieldRules: [
        { pattern: "count", type: "number", mock: "@float(3,3,2,2)" },
      ],
    })("count", { type: "number" }),
    3,
    "existing Local API float rules keep their own numeric interval semantics",
  );
  const positive = make("@float(3,3,2,2)"),
    negative = make("@float(-3,-3,2,2)");
  for (let i = 0; i < 12; i++) {
    const p = positive("count", { type: "number" }),
      n = negative("count", { type: "number" });
    assert(p > 3 && p < 4);
    assert(n < -3 && n > -4);
    assert.match(String(p), /^3\.[0-9][1-9]$/);
    assert.match(String(n), /^-3\.[0-9][1-9]$/);
  }
  assert.equal(make("@float(6,6,0,0)")("count", { type: "number" }), 6);
  assert.equal(
    make("@float(3,3,2,2)")("count", { type: "integer" }),
    undefined,
  );
  for (const expression of [
    "@float(1,2)",
    "@float(1,2,0,7)",
    "@float(1,2,3,2)",
    "@float(1.5,2,1,1)",
    "@float(1000001,1000001,1,1)",
  ]) {
    assert.throws(() => make(expression));
  }
  const doc = modernApipostFixture();
  doc.global.mock_custom_rules = [
    rule({ mock_rule_content: "@float(1,2,1,1)" }),
  ];
  assert.throws(() => importIntoProject(project(), doc));
});
