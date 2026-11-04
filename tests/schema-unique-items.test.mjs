import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { sampleFromSchema } from "../src/schema-sample.mjs";

const schemaFor = (values) => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "array",
  minItems: 2,
  maxItems: 2,
  uniqueItems: true,
  items: { enum: values },
});
const alternatives = () => [{ a: 1, b: 2 }, { b: 2, a: 1 }, { a: 3 }];

test("unique array samples use JSON object equality rather than key insertion order", () => {
  const schema = schemaFor(alternatives());
  const ajv = new Ajv2020({ strict: false });
  assert.equal(ajv.validateSchema(schema), true);
  const validate = ajv.compile(schema);
  const result = sampleFromSchema(schema);
  assert.equal(validate(result), true, JSON.stringify(validate.errors));
  assert.deepEqual(result, [{ a: 1, b: 2 }, { a: 3 }]);
});

test("a structurally duplicate enum cannot satisfy unique array cardinality", () => {
  const schema = schemaFor(alternatives().slice(0, 2));
  assert.equal(new Ajv2020({ strict: false }).validateSchema(schema), true);
  assert.throws(() => sampleFromSchema(schema), /唯一|unique/i);
});

test("ordinary distinct scalar and ordered-array enum choices remain valid", () => {
  for (const values of [
    [0, 1],
    [false, true],
    [null, "null"],
    [
      [1, 2],
      [2, 1],
    ],
  ]) {
    const schema = schemaFor(values);
    const value = sampleFromSchema(schema);
    assert.deepEqual(value, values);
    assert.equal(new Ajv2020({ strict: false }).compile(schema)(value), true);
  }
});

test("owner-saved unique Schema Mock remains valid or explicitly fails across restart without state changes", async () => {
  const { createApp } = await import("../src/server.mjs");
  const root = await mkdtemp(path.join(tmpdir(), "mock-unique-http-"));
  let app;
  const close = async () => {
    if (app) {
      const closing = app;
      app = undefined;
      await new Promise((resolve, reject) =>
        closing.server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  };
  const schema = schemaFor(alternatives());
  const validate = new Ajv2020({ strict: false }).compile(schema);
  const observations = [];
  try {
    app = await createApp({ root, port: 0 });
    const project = await app.store.create("Unique Mock contract");
    project.requests = [
      {
        id: "possible",
        name: "Possible",
        method: "GET",
        url: "http://127.0.0.1/never-executed",
        responses: [{ status: 200, schema }],
      },
      {
        id: "impossible",
        name: "Impossible",
        method: "GET",
        url: "http://127.0.0.1/never-executed",
        responses: [
          { status: 200, schema: schemaFor(alternatives().slice(0, 2)) },
        ],
      },
      {
        id: "healthy",
        name: "Healthy",
        method: "GET",
        url: "http://127.0.0.1/never-executed",
        examples: [{ status: 200, body: "healthy" }],
      },
    ];
    const saved = await fetch(app.url + "/api/projects/" + project.id, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      body: JSON.stringify(project),
    });
    assert.equal(saved.status, 200, await saved.text());
    const persisted = await app.store.get(project.id);
    for (let generation = 0; generation < 2; generation++) {
      for (const id of ["possible", "impossible", "healthy"]) {
        const response = await fetch(
          app.url + "/mock/" + project.id + "/" + id,
        );
        observations.push({
          generation,
          id,
          status: response.status,
          body: await response.text(),
        });
      }
      assert.deepEqual(await app.store.get(project.id), persisted);
      if (!generation) {
        await close();
        app = await createApp({ root, port: 0 });
      }
    }
    for (const observation of observations) {
      if (observation.id === "possible") {
        assert.equal(observation.status, 200);
        assert.equal(
          validate(JSON.parse(observation.body)),
          true,
          JSON.stringify({ observation, errors: validate.errors }),
        );
      } else if (observation.id === "impossible") {
        assert.equal(observation.status, 400, JSON.stringify(observation));
        assert.match(JSON.parse(observation.body).error, /唯一|unique/i);
      } else {
        assert.equal(observation.status, 200);
        assert.equal(observation.body, "healthy");
      }
    }
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

test("JSON equality preserves nested array order, numeric values and ordinary special keys", () => {
  const first = JSON.parse(
    '{"__proto__":{"safe":true},"constructor":{"x":1},"toString":"plain","valueOf":0}',
  );
  const duplicate = JSON.parse(
    '{"valueOf":0,"toString":"plain","constructor":{"x":1},"__proto__":{"safe":true}}',
  );
  const cases = [
    [
      [
        { x: { a: 1, b: 2 }, y: [1, 2] },
        { y: [1, 2], x: { b: 2, a: 1 } },
        { y: [2, 1], x: { a: 1, b: 2 } },
      ],
      2,
    ],
    [[-0, 0, 1], 2],
    [[1, "1", true, null], 2],
    [[first, duplicate, { other: true }], 2],
    [[Object.assign(Object.create(null), { a: 1 }), { a: 1 }, { a: 2 }], 2],
  ];
  for (const [values, count] of cases) {
    const schema = { ...schemaFor(values), minItems: count, maxItems: count };
    const result = sampleFromSchema(schema);
    assert.equal(result.length, count);
    // The Ajv implementation has its own special-key constructor/toString
    // assumptions, so test those legal JSON keys directly rather than calling it.
    if (values[0] === first) assert.deepEqual(result, [first, { other: true }]);
    else
      assert.equal(
        new Ajv2020({ strict: false }).compile(
          JSON.parse(JSON.stringify(schema)),
        )(JSON.parse(JSON.stringify(result))),
        true,
      );
  }
  assert.equal(
    Object.getPrototypeOf(
      sampleFromSchema(schemaFor([first, { other: true }]))[0],
    ),
    Object.prototype,
  );
  assert.equal(
    Object.hasOwn(
      sampleFromSchema(schemaFor([first, { other: true }]))[0],
      "__proto__",
    ),
    true,
  );
  for (const tuple of [
    { prefixItems: [{ const: -0 }, { const: 0 }] },
    { items: [{ const: -0 }, { const: 0 }] },
  ]) {
    assert.throws(
      () =>
        sampleFromSchema({
          type: "array",
          minItems: 2,
          uniqueItems: true,
          ...tuple,
        }),
      /唯一/,
    );
  }
});

test("non-JSON enum candidates reject without invoking accessors or Proxy traps", () => {
  let calls = 0;
  const getter = Object.defineProperty({}, "x", {
    enumerable: true,
    get() {
      calls++;
      return 1;
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        calls++;
        return [];
      },
      get() {
        calls++;
        return 1;
      },
      getPrototypeOf() {
        calls++;
        return Object.prototype;
      },
    },
  );
  const inherited = Object.create(proxy);
  const sparse = new Array(2);
  for (const candidate of [
    getter,
    proxy,
    inherited,
    sparse,
    [undefined],
    { x: undefined },
    NaN,
    Infinity,
    new Date(0),
  ]) {
    assert.throws(
      () => sampleFromSchema(schemaFor([candidate, 1])),
      /JSON|访问器|稀疏|Proxy/,
    );
    assert.equal(calls, 0);
  }
  const array = [0, 1];
  Object.defineProperty(array, "0", {
    enumerable: true,
    get() {
      calls++;
      return 0;
    },
  });
  assert.throws(() => sampleFromSchema(schemaFor(array)), /访问器/);
  assert.equal(calls, 0);
  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => sampleFromSchema(schemaFor([cycle, 1])), /循环/);
});

test("unique candidate work is cumulatively bounded before comparison and resets per invocation", () => {
  const wrap = (n) => {
    let result = 0;
    while (n--) result = [result];
    return result;
  };
  assert.equal(sampleFromSchema(schemaFor([wrap(31), 1])).length, 2);
  assert.throws(() => sampleFromSchema(schemaFor([wrap(32), 1])), /预算/);
  assert.deepEqual(
    sampleFromSchema(schemaFor([...Array(9998).fill(0), 1])),
    [0, 1],
  );
  assert.throws(
    () => sampleFromSchema(schemaFor([...Array(9999).fill(0), 1])),
    /预算/,
  );
  const text = "x".repeat(524286);
  assert.deepEqual(sampleFromSchema(schemaFor([text, text, 0])), [text, 0]);
  assert.throws(
    () => sampleFromSchema(schemaFor([text + "x", text + "x", 0])),
    /预算/,
  );
  const expensive = Array.from({ length: 100 }, (_, i) => "x".repeat(4000) + i);
  assert.throws(
    () =>
      sampleFromSchema({
        ...schemaFor(expensive),
        minItems: 100,
        maxItems: 100,
      }),
    /预算/,
  );
  const ordinary = Array.from({ length: 100 }, (_, i) => i);
  assert.deepEqual(
    sampleFromSchema({ ...schemaFor(ordinary), minItems: 100, maxItems: 100 }),
    ordinary,
  );
});

test("sparse arrays cannot masquerade as dense candidates using non-index numeric keys", () => {
  const sparse = ["a"];
  sparse.length = 2;
  sparse["4294967295"] = "b";
  assert.throws(() => sampleFromSchema(schemaFor(sparse)), /JSON|稀疏/);
  assert.throws(() => sampleFromSchema(schemaFor([sparse, 1])), /JSON|稀疏/);
});

test("unique tuple literal and reference candidates are checked before cloning without changing explicit top-level examples", () => {
  let calls = 0;
  const literal = Object.defineProperty({}, "x", {
    enumerable: true,
    get() {
      calls++;
      return 1;
    },
  });
  for (const key of ["const", "example", "default"]) {
    const schema = {
      type: "array",
      minItems: 2,
      uniqueItems: true,
      prefixItems: [{ [key]: literal }, { const: { b: 2 } }],
    };
    assert.throws(() => sampleFromSchema(schema), /访问器/);
    assert.equal(calls, 0);
    const referenced = {
      type: "array",
      minItems: 2,
      uniqueItems: true,
      prefixItems: [{ $ref: "#/$defs/A" }, { const: { b: 2 } }],
      $defs: { A: { [key]: literal } },
    };
    assert.throws(() => sampleFromSchema(referenced), /访问器/);
    assert.equal(calls, 0);
  }
  const definitions = Object.defineProperty({}, "A", {
    enumerable: true,
    get() {
      calls++;
      return { const: 1 };
    },
  });
  assert.throws(
    () =>
      sampleFromSchema({
        type: "array",
        minItems: 2,
        uniqueItems: true,
        prefixItems: [{ $ref: "#/$defs/A" }, { const: 2 }],
        $defs: definitions,
      }),
    /访问器/,
  );
  assert.equal(calls, 0);
  assert.deepEqual(
    sampleFromSchema({ type: "array", uniqueItems: true, example: [1, 1] }),
    [1, 1],
  );
});

test("a unique comparison budget failure cannot be swallowed by union fallback", () => {
  const values = Array.from({ length: 100 }, (_, i) => "x".repeat(4000) + i);
  const expensive = { ...schemaFor(values), minItems: 100, maxItems: 100 };
  assert.throws(
    () => sampleFromSchema({ anyOf: [expensive, { const: "fallback" }] }),
    /预算/,
  );
  let calls = 0;
  const later = Object.defineProperty({}, "const", {
    enumerable: true,
    get() {
      calls++;
      return "later";
    },
  });
  assert.throws(() => sampleFromSchema({ anyOf: [expensive, later] }), /预算/);
  assert.equal(calls, 0);
  assert.equal(sampleFromSchema({ const: "healthy" }), "healthy");
});
