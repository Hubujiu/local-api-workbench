import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  importOpenAPIPath,
  bindPathTemplates,
  validatePathSerialization,
  serializeRequestPath,
  pathParameterDefinition,
  validatePathTemplateVariables,
} from "../src/path-serialization.mjs";
import { applyMCPInput } from "../src/mcp-request-input.mjs";
test("dynamic entry imports its path admission guard before SDK resolution", () => {
  // Source-only regression: do not import or execute the dynamic/VM module here.
  const source = readFileSync(
    new URL("../src/dynamic-values.mjs", import.meta.url),
    "utf8",
  );
  const imported = source.match(
    /import\s*\{([^}]+)\}\s*from\s*["']\.\/path-serialization\.mjs["']/u,
  );
  assert(imported, "path serializer must be statically imported");
  assert(
    imported[1]
      .split(",")
      .some((name) => name.trim() === "validatePathSerialization"),
    "the entry guard must have a bound import, not an unbound global",
  );
  const entry = source.slice(
    source.indexOf("export async function resolveDynamicRequest("),
  );
  const guard = entry.indexOf("validatePathSerialization(request);");
  assert(guard >= 0);
  assert(guard < entry.indexOf("normalizeScriptURLMode("));
});
const row = (style = "simple", value = "blue", extra = {}) =>
  importOpenAPIPath(
    {
      name: "color",
      in: "path",
      required: true,
      schema: { type: "string" },
      style,
      example: value,
      ...extra,
    },
    true,
  );
const request = (item = row()) => ({
  url: "https://example.test/items/{color}?q=keep#fragment",
  path: [item],
});
test("path admission preserves object-array errors before scanning any row group", () => {
  for (const input of [undefined, null, false, 0, "request", []])
    assert.throws(
      () => validatePathSerialization(input),
      /接口定义必须是对象/u,
    );
  for (const group of ["path", "query", "headers", "cookies", "form"])
    for (const value of [
      {},
      "invalid",
      null,
      false,
      0,
      [null],
      [false],
      [[]],
      ["x"],
    ]) {
      const input = { url: "https://example.test/", [group]: value },
        before = structuredClone(input);
      assert.throws(
        () => validatePathSerialization(input),
        (error) =>
          !(error instanceof TypeError) &&
          error.message === group + " 必须是对象数组",
      );
      assert.deepEqual(input, before);
    }
  validatePathSerialization({ url: "https://example.test/" });
});
test("closed SDK facade preflights table shape before scanning path metadata", () => {
  const source = readFileSync(
    new URL("../src/script-url-runtime.mjs", import.meta.url),
    "utf8",
  );
  const entry = source.slice(
    source.indexOf("export function initializeQueryRuntime("),
  );
  const preflight = entry.indexOf('throw Error("SDK URL参数表最多1000项")'),
    marker = entry.indexOf('Object.hasOwn(row, "pathSerialization")'),
    construct = entry.indexOf("new sdk.Url(raw)");
  assert(preflight >= 0 && marker > preflight && construct > marker);
});
test("scalar simple label and matrix preserve delimiters and encode data once", () => {
  const value = "中文 /%?!'()*;=,+";
  const encoded = "%E4%B8%AD%E6%96%87%20%2F%25%3F%21%27%28%29%2A%3B%3D%2C%2B";
  for (const [style, prefix] of [
    ["simple", ""],
    ["label", "."],
    ["matrix", ";color="],
  ])
    for (const explode of [false, true]) {
      const source = request(row(style, value, { explode })),
        before = structuredClone(source);
      assert.equal(
        serializeRequestPath(source),
        `https://example.test/items/${prefix}${encoded}?q=keep#fragment`,
      );
      assert.deepEqual(source, before);
      assert.deepEqual(pathParameterDefinition(source.path[0]), {
        style,
        explode,
        example: value,
      });
    }
});
test("primitive zero and false are real values; missing examples stay unbound", () => {
  for (const value of [0, false])
    assert(
      serializeRequestPath(
        request(row("matrix", value, { schema: { type: typeof value } })),
      ).includes(";color=" + value),
    );
  const unbound = importOpenAPIPath(
    { name: "color", in: "path", required: true, schema: { type: "string" } },
    true,
  );
  validatePathSerialization(request(unbound));
  assert.deepEqual(pathParameterDefinition(unbound), {
    style: "simple",
    explode: false,
  });
  assert.throws(() => serializeRequestPath(request(unbound)), /尚未绑定/);
});
test("unsupported definitions and scalar values fail without value leakage", () => {
  for (const extra of [
    { required: false },
    { style: "form" },
    { explode: "false" },
    { schema: { type: "array", items: { type: "string" } } },
    { schema: { type: "object" } },
    { schema: { type: "string", nullable: true } },
    { example: null },
    { example: { secret: "DO_NOT_ECHO" } },
    { example: ["DO_NOT_ECHO"] },
    { example: NaN },
    { example: "\ud800" },
    { example: "line\nbreak" },
    { content: {} },
    { examples: {} },
  ]) {
    assert.throws(
      () => row("simple", "blue", extra),
      (error) => !error.message.includes("DO_NOT_ECHO"),
    );
  }
});
test("whole segment and uniqueness validation prevents authority/query/fragment or partial replacement", () => {
  for (const url of [
    "https://{color}/items",
    "https://example.test/pre{color}",
    "https://example.test/{color}/{color}",
    "https://example.test/items?q={color}",
    "https://example.test/items#{color}",
    "https://example.test/{color}/{missing}",
  ])
    assert.throws(() => validatePathSerialization({ ...request(), url }));
  assert.throws(() =>
    validatePathSerialization({ ...request(), path: [row(), row()] }),
  );
  assert.throws(() =>
    validatePathSerialization(request({ ...row(), enabled: false })),
  );
  for (const marker of [
    undefined,
    null,
    {},
    { version: 2, style: "simple", explode: false },
  ])
    assert.throws(() =>
      validatePathSerialization(
        request({ ...row(), pathSerialization: marker }),
      ),
    );
});
test("dot segment normalization is refused only for marked final dot segments", () => {
  for (const [style, value] of [
    ["simple", "."],
    ["simple", ".."],
    ["label", "."],
  ])
    assert.throws(() => serializeRequestPath(request(row(style, value))));
  assert(
    serializeRequestPath(request(row("matrix", ".."))).includes(";color=.."),
  );
  assert(serializeRequestPath(request(row("simple", "%2E"))).includes("%252E"));
  assert(
    serializeRequestPath({
      url: "https://example.test/pre{color}",
      path: [{ key: "color", value: "." }],
    }).endsWith("pre."),
  );
});
test("SDK and dynamic definitions never silently erase marked serialization", () => {
  for (const extra of [{ scriptURLMode: "sdk" }, { scriptURLRuntime: {} }])
    assert.throws(() => validatePathSerialization({ ...request(), ...extra }));
  assert.throws(() =>
    pathParameterDefinition({
      ...row(),
      dynamic: { source: "fixed", value: "x" },
    }),
  );
  assert.throws(() => pathParameterDefinition(row("simple", "{{color}}")));
});
test("raw template and MCP compound inputs fail before stringify; literal JSON-looking strings stay strings", () => {
  const source = request(row("matrix", "{{input}}")),
    before = structuredClone(source);
  for (const input of [[], {}, null, NaN]) {
    assert.throws(() => validatePathTemplateVariables(source, { input }));
    assert.throws(() => applyMCPInput(source, { path: { color: input } }));
  }
  for (const input of [false, 0, "a,b", "{}"]) {
    validatePathTemplateVariables(source, { input });
    const typedSource = structuredClone(source);
    typedSource.path[0].schema.type = typeof input;
    const patched = applyMCPInput(typedSource, { path: { color: input } });
    assert.equal(patched.path[0].value, input);
    assert(serializeRequestPath(patched).includes(";color="));
  }
  assert.deepEqual(source, before);
});
test("unmarked Swagger and native rows retain legacy substitution and output", () => {
  const legacy = importOpenAPIPath(
    { name: "color", type: "string", example: "!'()*" },
    false,
  );
  assert.equal(Object.hasOwn(legacy, "pathSerialization"), false);
  assert(serializeRequestPath(request(legacy)).includes("!'()*"));
});

test("typed template binding preserves single-pass interpolation and numeric identity", () => {
  const source = request(row("matrix", "{{v}}"));
  const vars = { v: "{{other}}", other: "expanded" };
  const bound = bindPathTemplates(structuredClone(source), vars);
  assert.equal(bound.path[0].value, "{{v}}");
  bound.path[0].value = bound.path[0].value.replace(
    /\{\{([^{}]+)\}\}/g,
    (_, key) => String(vars[key]),
  );
  assert.equal(bound.path[0].value, "{{other}}");
  assert.throws(() => serializeRequestPath(bound), /尚未绑定/);
  for (const value of [false, 0, 1.5]) {
    const typed = request(
      row("matrix", "{{v}}", { schema: { type: typeof value } }),
    );
    assert.equal(bindPathTemplates(typed, { v: value }).path[0].value, value);
  }
  for (const [type, value] of [
    ["integer", 1.5],
    ["boolean", "false"],
    ["string", 1],
  ])
    assert.throws(() => row("simple", value, { schema: { type } }));
  for (const extra of [{ example: "" }, { style: null }, { explode: null }])
    assert.throws(() => row("simple", "x", extra));
  const misplaced = {
    ...request(),
    query: [{ key: "q", value: "x", pathSerialization: {} }],
  };
  assert.throws(() => validatePathSerialization(misplaced));
});

test("service-relative pathname definitions retain markers without admitting authority references", () => {
  const relative = {
    ...request(row("matrix", "42")),
    url: "/v1/one%2Ftwo/items/{color}",
  };
  validatePathSerialization(relative);
  assert.equal(serializeRequestPath(relative), "/v1/one%2Ftwo/items/;color=42");
  assert.throws(() =>
    validatePathSerialization({ ...relative, url: "//{color}/items" }),
  );
  assert.throws(() =>
    validatePathSerialization({
      ...relative,
      url: "//example.test/items/{color}",
    }),
  );
});
