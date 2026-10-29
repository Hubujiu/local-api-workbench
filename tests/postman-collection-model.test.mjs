import test from "node:test";
import assert from "node:assert/strict";
import {
  postmanVariableMode,
  preparePostmanCollection,
  appendPostmanCollection,
  validatePostmanCollections,
  rejectCollectionExport,
  collectionJSON,
  castCollectionValue,
} from "../src/postman-collection-scopes.mjs";
const source = (variable = []) => ({
  info: { name: "Collection 雪" },
  item: [],
  variable,
});
const project = () => ({
  requests: [],
  cases: [],
  plans: [],
  environments: [{ id: "env", variables: {} }],
});
test("collection opt-in preserves last-enabled typed/falsy values and allocates independent identities", () => {
  const input = source([
    { key: "x", value: "first" },
    { key: "x", value: "last" },
    { key: "x", disabled: true, value: "disabled" },
    { key: "zero", type: "number", value: "0" },
    { key: "bool", type: "boolean", value: false },
    { key: "empty", value: "" },
    { key: "nil", value: null },
    { key: "text", type: "string", value: 0 },
    { key: "object", value: { a: [false, 0, null] } },
  ]);
  const before = structuredClone(input);
  const a = preparePostmanCollection(input, () => "a"),
    b = preparePostmanCollection(input, () => "b");
  assert.deepEqual(a.variables, {
    x: "last",
    zero: 0,
    bool: false,
    empty: "",
    nil: null,
    text: "0",
    object: { a: [false, 0, null] },
  });
  assert.notEqual(a.id, b.id);
  a.variables.object.a.push("changed");
  assert.deepEqual(input, before);
  assert.deepEqual(b.variables.object, { a: [false, 0, null] });
  assert.equal(postmanVariableMode(), "environment");
  assert.equal(postmanVariableMode("collection"), "collection");
  assert.throws(() => postmanVariableMode(null), /postmanVariableMode/);
});
test("registry and request bindings compose without mutating sources and survive JSON backup", () => {
  const p = project(),
    a = preparePostmanCollection(source(), () => "a");
  const before = structuredClone(p);
  const first = appendPostmanCollection(p, a, [{ id: "request-a" }]);
  assert.deepEqual(p, before);
  Object.assign(p, {
    postmanCollections: first.registry,
    requests: first.requests,
  });
  p.plans = [
    { steps: [{ id: "frozen", request: { postmanCollectionId: "a" } }] },
  ];
  const restored = JSON.parse(JSON.stringify({ ...p, id: "new-project" }));
  assert.doesNotThrow(() => validatePostmanCollections(restored));
  const b = preparePostmanCollection(source(), () => "b");
  const next = appendPostmanCollection(p, b, [{ id: "request-b" }]);
  assert.equal(next.requests[0].postmanCollectionId, "b");
  assert.equal(next.registry.items.length, 2);
  assert.equal(p.postmanCollections.items.length, 1);
  assert.throws(() => rejectCollectionExport(p, "OpenAPI"), /完整项目备份/);
});
test("malformed or forged collection configurations reject without repairing history or input", () => {
  for (const rows of [
    [{ key: "bad" }],
    [{ key: "__proto__", value: "x" }],
    [{ key: "x", type: "secret", value: "x" }],
    [{ key: "x", type: "number", value: "no" }],
    [{ key: "x", value: "x", source: { provider: "external" } }],
  ])
    assert.throws(() => preparePostmanCollection(source(rows), () => "a"));
  const p = project(),
    a = preparePostmanCollection(source([{ key: "x", value: 0 }]), () => "a");
  p.postmanCollections = { version: 1, items: [a] };
  p.requests = [{ id: "r", postmanCollectionId: "missing" }];
  const before = JSON.stringify(p);
  assert.throws(() => validatePostmanCollections(p), /引用不存在/);
  assert.equal(JSON.stringify(p), before);
  p.requests = [];
  p.runs = [
    {
      snapshot: {
        steps: [{ request: { postmanCollectionId: "historical-missing" } }],
      },
    },
  ];
  assert.doesNotThrow(() => validatePostmanCollections(p));
  p.postmanCollections.items.push(structuredClone(a));
  assert.throws(() => validatePostmanCollections(p), /标识重复/);
});
test("pure collection JSON admits no accessor/function/nonfinite or mutable host values", () => {
  let read = 0;
  const input = {};
  Object.defineProperty(input, "secret", {
    enumerable: true,
    get() {
      read++;
      throw Error("must not read");
    },
  });
  assert.throws(() => collectionJSON(input), /访问器/);
  assert.equal(read, 0);
  for (const value of [
    undefined,
    NaN,
    Infinity,
    () => {},
    new Date(),
    Array(1),
  ])
    assert.throws(() => collectionJSON(value));
  assert.equal(castCollectionValue(null, "string"), "null");
  assert.equal(castCollectionValue("false", "boolean"), true);
  assert.throws(() => castCollectionValue({}, "number"), /标量/);
});
