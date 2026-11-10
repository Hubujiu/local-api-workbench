import test from "node:test";
import assert from "node:assert/strict";
import {
  importDocument,
  exportOpenAPI,
  toCurl,
  normalizeRequest,
  interpolate,
  snapshotPlan,
} from "../src/core.mjs";
import { resolveDynamicRequest } from "../src/dynamic-values.mjs";
import { applyMCPInput } from "../src/mcp-request-input.mjs";
import { objectParameterDocument } from "./fixtures/openapi-object-parameters.mjs";

const parameter = (extra = {}) => ({
  in: "header",
  name: "X-Filter",
  schema: {
    type: "object",
    properties: {
      role: { type: "string" },
      active: { type: "boolean" },
      count: { type: "integer" },
    },
  },
  example: { role: "a,b=c/% 中文", active: false, count: 0 },
  ...extra,
});
const request = (extra = {}, version = "3.1.0") =>
  importDocument(objectParameterDocument(version, parameter(extra)))[0];
const value = "role,a%2Cb%3Dc%2F%25%20%E4%B8%AD%E6%96%87,active,false,count,0";

test("OAS3 Header flat objects use RFC6570 simple/explode and preserve definitions on roundtrip", () => {
  for (const version of ["3.0.3", "3.1.0"])
    for (const explode of [undefined, false, true]) {
      const r = request(explode === undefined ? {} : { explode }, version);
      assert.deepEqual(r.headers[0].headerSerialization, {
        version: 1,
        style: "simple",
        explode: explode === true,
      });
      assert.deepEqual(JSON.parse(r.headers[0].value), parameter().example);
      assert(
        toCurl(r).includes(
          "x-filter: " +
            (explode
              ? value
                  .replace("role,", "role=")
                  .replace(",active,", ",active=")
                  .replace(",count,", ",count=")
              : value),
        ),
      );
      const exported = exportOpenAPI({ name: "Objects", requests: [r] });
      assert.deepEqual(
        exported.paths["/check"].get.parameters[0].example,
        parameter().example,
      );
      assert.deepEqual(importDocument(exported)[0].headers, r.headers);
    }
});

test("Header object interpolation escapes JSON grammar before serializing components", async () => {
  const r = request({ example: { role: "{{text}}", active: false, count: 0 } });
  const text = 'quote"\\line\r\nnext,evil=x';
  const resolved = await resolveDynamicRequest(r, { text }, [], interpolate);
  assert.deepEqual(JSON.parse(resolved.headers[0].value), {
    role: text,
    active: false,
    count: 0,
  });
  assert(toCurl(resolved).includes("quote%22%5Cline%0D%0Anext%2Cevil%3Dx"));
  assert.equal(JSON.parse(r.headers[0].value).role, "{{text}}");
});

test("Header object dynamic values, MCP temporary values and frozen snapshots retain codec", async () => {
  const r = request();
  r.headers[0].dynamic = {
    source: "fixed",
    value: { role: "dynamic", active: true, count: 3 },
  };
  assert.throws(() => toCurl(r), /动态.*cURL/);
  assert.throws(
    () => exportOpenAPI({ name: "Dynamic", requests: [r] }),
    /动态.*OpenAPI/,
  );
  const resolved = await resolveDynamicRequest(r, {}, [], interpolate);
  assert(toCurl(resolved).includes("role,dynamic,active,true,count,3"));
  const temporary = applyMCPInput(r, {
    headers: { "x-filter": { role: "temporary", active: false, count: 8 } },
  });
  const plan = snapshotPlan({ steps: [{ request: temporary }] });
  temporary.headers[0].value = "{}";
  assert(
    toCurl(plan.steps[0].request).includes(
      "role,temporary,active,false,count,8",
    ),
  );
  assert.throws(
    () => applyMCPInput(r, { headers: { "X-Filter": "{}" } }),
    /对象/,
  );
  assert.equal(r.headers[0].dynamic.value.role, "dynamic");
});

test("Header object marker rejects relocation, corruption and malformed or nested values, including disabled rows", () => {
  for (const change of [
    (row) => {
      row.headerSerialization.version = 2;
    },
    (row) => {
      row.headerSerialization.extra = true;
    },
    (row) => {
      row.headerSerialization.explode = null;
    },
    (row) => {
      row.value = "[]";
    },
    (row) => {
      row.value = '{"nested":{}}';
    },
    (row) => {
      row.value = '{"count":1.5}';
    },
    (row) => {
      row.value = '{"text":null}';
    },
    (row) => {
      row.value = '{"text":"\\ud800"}';
    },
    (row) => {
      row.value = '{"text":9007199254740992}';
    },
  ]) {
    const r = request();
    change(r.headers[0]);
    r.headers[0].enabled = false;
    assert.throws(() => normalizeRequest(r), /OpenAPI Header对象/);
  }
  for (const group of ["query", "path", "cookies", "form"]) {
    const r = request();
    r[group] = r.headers;
    r.headers = [];
    assert.throws(() => normalizeRequest(r), /Header对象/);
  }
});

test("Header object selection supports defaults, one explicit example and empty objects", () => {
  for (const extra of [
    { example: {} },
    { example: { "": "", "a,b": "=", plus: "+" } },
  ])
    assert.doesNotThrow(() => toCurl(request(extra)));
  for (const field of ["default", "example"]) {
    const p = parameter();
    delete p.example;
    p.schema[field] = { role: "selected" };
    assert.equal(
      JSON.parse(
        importDocument(objectParameterDocument("3.1.0", p))[0].headers[0].value,
      ).role,
      "selected",
    );
  }
  const p = parameter();
  delete p.example;
  p.examples = { one: { value: { role: "selected" } } };
  assert.equal(
    JSON.parse(
      importDocument(objectParameterDocument("3.1.0", p))[0].headers[0].value,
    ).role,
    "selected",
  );
  assert.throws(() => request({ examples: { one: { value: {} } } }), /example/);
  for (const extra of [
    { style: "form" },
    { explode: "false" },
    { content: {} },
    { schema: { type: "object", properties: { nested: { type: "object" } } } },
  ])
    assert.throws(() => request(extra), /Header对象/);
});

test("Header object reference and path inheritance preserve simple serialization", () => {
  for (const version of ["3.0.3", "3.1.0"])
    for (const inherited of [false, true]) {
      const source = objectParameterDocument(
        version,
        parameter({ explode: true }),
      );
      source.components = {
        parameters: { Header: source.paths["/check"].get.parameters[0] },
      };
      const refs = [{ $ref: "#/components/parameters/Header" }];
      if (inherited) {
        source.paths["/check"].parameters = refs;
        delete source.paths["/check"].get.parameters;
      } else source.paths["/check"].get.parameters = refs;
      const before = structuredClone(source);
      assert(
        toCurl(importDocument(source)[0]).includes(
          "role=a%2Cb%3Dc%2F%25%20%E4%B8%AD%E6%96%87,active=false,count=0",
        ),
      );
      assert.deepEqual(source, before);
    }
});

test("Header objects enforce marker data properties, individual and aggregate encoding limits", () => {
  for (const make of [
    (row) =>
      Object.defineProperty(row, "headerSerialization", {
        enumerable: true,
        get() {
          throw Error("getter invoked");
        },
      }),
    (row) => {
      row.headerSerialization = {
        version: 1,
        style: "simple",
        get explode() {
          throw Error("getter invoked");
        },
      };
    },
    (row) => {
      row.headerSerialization = Object.create({
        version: 1,
        style: "simple",
        explode: false,
      });
    },
  ]) {
    const r = request();
    make(r.headers[0]);
    assert.throws(() => normalizeRequest(r), /序列化标记无效/);
  }
  const r = request();
  r.headers[0].value = JSON.stringify({ role: "中".repeat(8000) });
  assert.throws(() => normalizeRequest(r), /编码后参数超过/);
  r.headers[0].value = JSON.stringify({ role: "x".repeat(40000) });
  r.headers.push({ ...structuredClone(r.headers[0]), key: "X-Other" });
  assert.throws(() => normalizeRequest(r), /编码总量/);
  r.headers[1].enabled = false;
  assert.doesNotThrow(() => normalizeRequest(r));
});

test("bare object schemas and typed dictionaries retain scalar property values without inference", () => {
  for (const schema of [
    { type: "object" },
    { type: "object", additionalProperties: { type: "string" } },
  ]) {
    const r = request({ schema, example: { item: "value,=%" } });
    assert(toCurl(r).includes("item,value%2C%3D%25"));
    assert.deepEqual(
      importDocument(exportOpenAPI({ name: "Dictionary", requests: [r] }))[0]
        .headers,
      r.headers,
    );
  }
  assert.throws(
    () =>
      request({
        schema: { type: "object", additionalProperties: false },
        example: { item: "value" },
      }),
    /未声明属性/,
  );
  const r = request({ example: {} });
  assert(toCurl(r).includes("'x-filter;'"));
});

test("OpenAPI cannot silently collapse repeated Header object/scalar rows", () => {
  for (const markedFirst of [false, true]) {
    const r = request();
    const plain = { key: "x-filter", value: "ordinary", enabled: true };
    if (markedFirst) r.headers.push(plain);
    else r.headers.unshift(plain);
    assert.doesNotThrow(() => toCurl(r));
    assert.throws(
      () => exportOpenAPI({ name: "Duplicates", requests: [r] }),
      /同名Header对象/,
    );
    plain.enabled = false;
    assert.doesNotThrow(() =>
      exportOpenAPI({ name: "Disabled duplicate", requests: [r] }),
    );
  }
});

test("PR162 const/enum normalization keeps Header root and property constraints reimportable", () => {
  for (const explode of [false, true])
    for (const schema of [
      {
        type: "object",
        properties: { role: { type: "string" } },
        const: { role: "admin" },
        enum: [{ role: "admin" }, { role: "member" }],
      },
      {
        type: "object",
        properties: {
          role: { type: "string", const: "admin", enum: ["admin", "member"] },
        },
      },
      {
        type: "object",
        properties: {
          count: { type: "number", minimum: 2, exclusiveMinimum: 3 },
        },
      },
    ]) {
      const example = schema.properties.role ? { role: "admin" } : { count: 4 };
      const r = request({ schema, example, explode });
      const output = exportOpenAPI({
        name: "Conjoined constraints",
        requests: [r],
      });
      const [again] = importDocument(output);
      assert.deepEqual(
        again.headers[0].headerSerialization,
        r.headers[0].headerSerialization,
      );
      assert.equal(toCurl(again), toCurl(r));
      assert.deepEqual(
        exportOpenAPI({ name: "Conjoined constraints", requests: [again] }),
        output,
      );
      if (schema.const)
        assert.deepEqual(again.headers[0].schema.allOf, [
          { enum: [schema.const] },
        ]);
      if (schema.properties.role?.const)
        assert.deepEqual(again.headers[0].schema.properties.role.allOf, [
          { enum: ["admin"] },
        ]);
    }
});

test("Header enum-only intersections do not admit general composed or nested schemas", () => {
  for (const allOf of [
    [],
    [{}],
    [{ type: "object" }],
    [{ enum: [{}], properties: { nested: { type: "object" } } }],
    [{ enum: ["allowed"], oneOf: [] }],
  ]) {
    assert.throws(
      () => request({ schema: { type: "object", allOf } }),
      /Header对象/,
    );
    assert.throws(
      () =>
        request({
          schema: {
            type: "object",
            properties: { role: { type: "string", allOf } },
          },
        }),
      /Header对象/,
    );
  }
});

test("Header enum-only conjunctions preserve typed dictionaries and generated-entry capacity", () => {
  for (const schema of [
    {
      type: "object",
      additionalProperties: {
        type: "string",
        const: "admin",
        enum: ["admin", "member"],
      },
    },
    {
      type: "object",
      const: { role: "admin" },
      enum: [{ role: "admin" }],
      allOf: Array.from({ length: 1000 }, () => ({
        enum: [{ role: "admin" }],
      })),
    },
  ]) {
    const r = request({ schema, example: { role: "admin" } });
    const output = exportOpenAPI({ name: "Conjunctions", requests: [r] });
    const [again] = importDocument(output);
    assert.equal(toCurl(again), toCurl(r));
    assert.deepEqual(
      exportOpenAPI({ name: "Conjunctions", requests: [again] }),
      output,
    );
  }
});

test("Header conjunction arrays reject sparse and accessor definitions without invoking getters", () => {
  const sparse = Array(1),
    accessor = [],
    hidden = [{ enum: [{}] }];
  Object.defineProperty(accessor, "0", {
    enumerable: true,
    get() {
      throw Error("getter invoked");
    },
  });
  Object.defineProperty(hidden, "extra", { value: true });
  for (const allOf of [sparse, accessor, hidden]) {
    const r = request();
    r.headers[0].schema.allOf = allOf;
    assert.throws(() => normalizeRequest(r), /Header对象/);
  }
  const r = request();
  r.headers[0].schema.allOf = [
    {
      get enum() {
        throw Error("getter invoked");
      },
    },
  ];
  assert.throws(() => normalizeRequest(r), /Header对象/);
});
