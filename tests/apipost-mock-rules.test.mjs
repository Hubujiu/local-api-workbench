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
  doc.global.mock_custom_rules.push(
    rule({
      mock_custom_rule_id: "label",
      field_type: "string",
      match_rule: "label",
      mock_rule_content: '@string("a",3)',
    }),
  );
  doc.global.mock_custom_rules.push(
    rule({
      mock_custom_rule_id: "gender",
      field_type: "string",
      match_rule: "gender",
      mock_rule_content: '@pick(["女"])',
    }),
  );
  doc.global.mock_custom_rules.push(
    rule({
      mock_custom_rule_id: "code",
      field_type: "string",
      match_rule: "code",
      mock_rule_content: '@character("X")',
    }),
  );
  doc.global.mock_custom_rules.push(
    rule({
      mock_custom_rule_id: "word",
      field_type: "string",
      match_rule: "word",
      mock_rule_content: "@word(0)",
    }),
  );
  for (const name of ["title", "sentence", "paragraph"])
    doc.global.mock_custom_rules.push(
      rule({
        mock_custom_rule_id: name,
        field_type: "string",
        match_rule: name,
        mock_rule_content: "@" + name + "(0)",
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
      label: { type: "string" },
      gender: { type: "string" },
      code: { type: "string" },
      word: { type: "string" },
      title: { type: "string" },
      sentence: { type: "string" },
      paragraph: { type: "string" },
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
    label: "a",
    gender: "女",
    code: "X",
    word: "",
    title: "",
    sentence: ".",
    paragraph: "",
    Count: 3,
  });
  assert.deepEqual(await (await fetch(p.requests[0].url)).json(), {
    count: 7,
    explicit: 99,
    totalCount: 3,
    sum: 3,
    item_5: 3,
    price: 6,
    label: "a",
    gender: "女",
    code: "X",
    word: "",
    title: "",
    sentence: ".",
    paragraph: "",
    Count: 3,
  });
  const current = await app.store.get(p.id);
  current.settings.mockFieldRules.find(
    (rule) => rule.pattern === "price",
  ).mock = "@float(3,3,2,2)";
  current.settings.mockFieldRules.find((rule) => rule.pattern === "word").mock =
    "@word(4)";
  for (const name of ["title", "sentence", "paragraph"])
    current.settings.mockFieldRules.find((rule) => rule.pattern === name).mock =
      "@" + name + (name === "paragraph" ? "(1,1)" : "(2,2)");
  await app.store.save(current);
  const actualResponse = await (await fetch(p.requests[0].url)).json();
  assert.match(actualResponse.word, /^[a-z]{4}$/);
  assert.match(actualResponse.title, /^[A-Z][a-z]{2,9} [A-Z][a-z]{2,9}$/);
  assert.match(actualResponse.sentence, /^[A-Z][a-z]{2,9} [a-z]{3,10}\.$/);
  assert.match(
    actualResponse.paragraph,
    /^[A-Z][a-z]{2,9}( [a-z]{3,10}){11,17}\.$/,
  );
  const actualFloat = actualResponse.price;
  assert(actualFloat > 3 && actualFloat < 4);
  assert.match(String(actualFloat), /^3\.[0-9][1-9]$/);
  for (const expression of ["@guid()", "@uuid"]) {
    current.settings.mockFieldRules.find(
      (rule) => rule.pattern === "label",
    ).mock = expression;
    await app.store.save(current);
    assert.equal(
      (await app.store.get(p.id)).settings.mockFieldRules.find(
        (rule) => rule.pattern === "label",
      ).mock,
      expression,
    );
    const response = await fetch(p.requests[0].url);
    assert.equal(response.status, 200);
    assert.match(
      (await response.json()).label,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  }
  current.settings.mockFieldRules.find(
    (rule) => rule.pattern === "label",
  ).mock = '@string("Q")';
  await app.store.save(current);
  assert.equal((await (await fetch(p.requests[0].url)).json()).label, "Q");
  current.settings.mockFieldRules.find(
    (rule) => rule.pattern === "label",
  ).mock = "@char()";
  await app.store.save(current);
  const characterResponse = await fetch(p.requests[0].url);
  assert.equal(characterResponse.status, 200);
  assert.match(
    (await characterResponse.json()).label,
    /^[A-Za-z0-9!@#$%^&*()[\]]$/,
  );
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

test("native string rules sample explicit ASCII pools without replacement", () => {
  const make = (expression) => {
    const doc = modernApipostFixture();
    doc.global.mock_custom_rules = [
      rule({ field_type: "string", mock_rule_content: expression }),
    ];
    const p = project();
    importIntoProject(p, doc);
    p.settings.mockSeed = 42;
    return createFieldSampler(p.settings);
  };
  const full = make('@string("abc",3)'),
    duplicates = make('@string("aab",3)'),
    range = make('@string("abcd",1,2)');
  for (let i = 0; i < 8; i++) {
    assert.equal([...full("count", { type: "string" })].sort().join(""), "abc");
    assert.equal(
      [...duplicates("count", { type: "string" })].sort().join(""),
      "aab",
    );
    const value = range("count", { type: "string" });
    assert(value.length >= 1 && value.length <= 2);
    assert.equal(new Set(value).size, value.length);
  }
  assert.equal(make('@string("a",4)')("count", { type: "string" }), "a");
  assert.equal(make('@string("abc",0)')("count", { type: "string" }), "");
  assert.equal(
    make('@string("abc",3)')("count", { type: "integer" }),
    undefined,
  );
  assert.throws(
    () => make('@string("abc",3)')("count", { type: "string", maxLength: 1 }),
    /长度/,
  );
  for (const expression of [
    "@string(3)",
    '@string("@name",3)',
    '@string("中",1)',
    '@string("abc",65)',
    '@string("abc",2,1)',
    '@string("abc",1.5)',
    '@string("",0)',
    "@string('abc',3)",
  ]) {
    assert.throws(() => make(expression));
  }
});

test("native pick string lists return one literal candidate without evaluating nested expressions", () => {
  const make = (expression) => {
    const doc = modernApipostFixture();
    doc.global.mock_custom_rules = [
      rule({ field_type: "string", mock_rule_content: expression }),
    ];
    const p = project();
    const before = structuredClone(doc);
    importIntoProject(p, doc);
    assert.deepEqual(doc, before);
    return createFieldSampler(p.settings);
  };
  const sample = make('@pick(["男","女","👩‍💻"])');
  for (let i = 0; i < 12; i++)
    assert(["男", "女", "👩‍💻"].includes(sample("count", { type: "string" })));
  assert.equal(
    make('@pick(["{{literal}}"])')("count", { type: "string" }),
    "{{literal}}",
  );
  assert.equal(make('@pick([""])')("count", { type: "string" }), "");
  for (const expression of [
    "@pick([])",
    '@pick(["@name"])',
    "@pick([1])",
    '@pick([["a"]])',
    '@pick(["a"],2)',
    "@pick(" + JSON.stringify(Array(65).fill("a")) + ")",
    "@pick(" + JSON.stringify(["a".repeat(257)]) + ")",
  ])
    assert.throws(() => make(expression));
});

test("native character aliases select one ASCII character and preserve named pool semantics", () => {
  const make = (expression) => {
    const doc = modernApipostFixture();
    doc.global.mock_custom_rules = [
      rule({ field_type: "string", mock_rule_content: expression }),
    ];
    const p = project();
    importIntoProject(p, doc);
    return createFieldSampler(p.settings);
  };
  assert.equal(make('@character("X")')("count", { type: "string" }), "X");
  assert.equal(make('@char("X")')("count", { type: "string" }), "X");
  for (const [pool, pattern] of [
    ["LOWER", /^[a-z]$/],
    ["upper", /^[A-Z]$/],
    ["number", /^[0-9]$/],
    ["alpha", /^[a-zA-Z]$/],
    ["symbol", /^[!@#$%^&*()[\]]$/],
    ["abc", /^[abc]$/],
  ]) {
    const generate = make("@character(" + JSON.stringify(pool) + ")");
    for (let i = 0; i < 8; i++)
      assert.match(generate("count", { type: "string" }), pattern);
  }
  for (const expression of [
    "@character(null)",
    '@character("中")',
    '@character("@name")',
    '@character("constructor")',
    '@character("__proto__")',
    '@char("abc",2)',
    "@character(3)",
    '@character("")',
  ])
    assert.throws(() => make(expression));
});

test("native word rules retain default, fixed and ranged lowercase lengths", () => {
  const make = (expression) => {
    const doc = modernApipostFixture();
    doc.global.mock_custom_rules = [
      rule({ field_type: "string", mock_rule_content: expression }),
    ];
    const p = project();
    importIntoProject(p, doc);
    return createFieldSampler(p.settings);
  };
  for (const expression of ["@word", "@word()"]) {
    const sample = make(expression);
    for (let i = 0; i < 12; i++)
      assert.match(sample("count", { type: "string" }), /^[a-z]{3,10}$/);
  }
  assert.equal(make("@word(0)")("count", { type: "string" }), "");
  assert.match(make("@word(64)")("count", { type: "string" }), /^[a-z]{64}$/);
  const ranged = make("@word(2,5)");
  for (let i = 0; i < 12; i++)
    assert.match(ranged("count", { type: "string" }), /^[a-z]{2,5}$/);
  for (const expression of [
    "@word(-1)",
    "@word(65)",
    "@word(5,2)",
    "@word(1.5)",
    '@word("3")',
    "@word(1,2,3)",
  ])
    assert.throws(() => make(expression));
});

test("native title sentence and paragraph composition retains capitalization and punctuation", () => {
  const make = (expression) => {
    const doc = modernApipostFixture();
    doc.global.mock_custom_rules = [
      rule({ field_type: "string", mock_rule_content: expression }),
    ];
    const p = project();
    importIntoProject(p, doc);
    return createFieldSampler(p.settings);
  };
  const value = (expression) => make(expression)("count", { type: "string" });
  assert.equal(value("@title(0)"), "");
  assert.equal(value("@sentence(0)"), ".");
  assert.equal(value("@paragraph(0)"), "");
  assert.match(value("@title(2,2)"), /^[A-Z][a-z]{2,9} [A-Z][a-z]{2,9}$/);
  assert.match(value("@sentence(2,2)"), /^[A-Z][a-z]{2,9} [a-z]{3,10}\.$/);
  const sentence = /^[A-Z][a-z]{2,9}( [a-z]{3,10}){11,17}\.$/;
  assert.match(value("@sentence"), sentence);
  assert.match(value("@sentence()"), sentence);
  const paragraph = value("@paragraph(2,2)");
  assert.equal(paragraph.split(".").length - 1, 2);
  for (const s of paragraph.slice(0, -1).split(". "))
    assert.match(s + ".", sentence);
  assert.match(value("@title"), /^[A-Z][a-z]{2,9}( [A-Z][a-z]{2,9}){2,6}$/);
  assert(value("@paragraph(8)").length <= 2048);
  for (const expression of [
    "@title(33)",
    "@sentence(33)",
    "@paragraph(9)",
    "@paragraph(2,1)",
    "@title(-1)",
    "@sentence(1.5)",
    "@title(1,2,3)",
  ])
    assert.throws(() => make(expression));
});

test("native guid and uuid use effective UUIDv4 overrides, not the shadowed base guid", () => {
  const make = (expression) => {
    const doc = modernApipostFixture();
    doc.global.mock_custom_rules = [
      rule({ field_type: "string", mock_rule_content: expression }),
    ];
    const p = project();
    importIntoProject(p, doc);
    return createFieldSampler(p.settings);
  };
  for (const expression of ["@guid", "@guid()", "@uuid", "@uuid()"]) {
    const a = make(expression),
      b = make(expression);
    for (let i = 0; i < 32; i++) {
      const result = a("count", { type: "string" });
      assert.match(
        result,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      assert.equal(
        result,
        b("count", { type: "string" }),
        "seeded fixture output is deterministic, not secure identity generation",
      );
    }
    assert.equal(a("count", { type: "integer" }), undefined);
  }
  for (const expression of [
    "@guid(1)",
    '@uuid("seed")',
    "@guid(null)",
    "@uuid({})",
  ])
    assert.throws(() => make(expression));
});

test("native string no-count overloads emit one character, not base Mock.js default lengths", () => {
  const make = (expression) => {
    const doc = modernApipostFixture();
    doc.global.mock_custom_rules = [
      rule({ field_type: "string", mock_rule_content: expression }),
    ];
    const p = project();
    importIntoProject(p, doc);
    return createFieldSampler(p.settings);
  };
  for (const expression of ["@string", "@string()"]) {
    const sample = make(expression);
    for (let i = 0; i < 32; i++)
      assert.match(sample("count", { type: "string" }), /^[A-Za-z0-9]$/);
  }
  assert.equal(make('@string("X")')("count", { type: "string" }), "X");
  const literal = make('@string("lower")');
  for (let i = 0; i < 16; i++)
    assert.match(literal("count", { type: "string" }), /^[lower]$/);
  for (const expression of [
    '@string("")',
    '@string("@word")',
    '@string("😀")',
    "@string(3)",
    "@string(null)",
  ])
    assert.throws(() => make(expression));
});

test("native character default pools include letters digits and original symbols", () => {
  const make = (expression) => {
    const doc = modernApipostFixture();
    doc.global.mock_custom_rules = [
      rule({ field_type: "string", mock_rule_content: expression }),
    ];
    const p = project();
    importIntoProject(p, doc);
    return createFieldSampler(p.settings);
  };
  const pool =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()[]";
  for (const expression of ["@character", "@character()", "@char", "@char()"]) {
    const sample = make(expression),
      explicit = make('@character("undefined")');
    for (let i = 0; i < 128; i++) {
      const value = sample("count", { type: "string" });
      assert.equal(value.length, 1);
      assert(pool.includes(value));
      assert.equal(value, explicit("count", { type: "string" }));
    }
  }
  for (const expression of [
    '@char("")',
    "@character(null)",
    "@char(3)",
    '@char("a",1)',
  ])
    assert.throws(() => make(expression));
});
