import test from "node:test";
import assert from "node:assert/strict";
import {
  createGraphQLSchemaDirectory,
  LOCAL_SCHEMA_LIMIT,
  readLocalGraphQLSchema,
} from "../public/graphql-schema-directory.js";

const utf8 = (source) => new TextEncoder().encode(source);
const read = (doc) => readLocalGraphQLSchema(utf8(JSON.stringify(doc)));
const payload = ({
  queryType = { name: "Query" },
  types,
  mutationType,
} = {}) => ({
  data: {
    __schema: {
      queryType,
      mutationType,
      subscriptionType: null,
      types: types ?? [
        { kind: "OBJECT", name: "Query", description: "not retained" },
        { kind: "ENUM", name: "Role", enumValues: [{ name: "USER" }] },
        { kind: "SCALAR", name: "ID" },
      ],
    },
  },
});

test("schema import projects only validated operation roots and named type summaries", () => {
  const original = payload();
  const summary = read({
    ...original,
    errors: [],
    extensions: { notRetained: true },
  });
  assert.deepEqual(summary, {
    roots: [{ role: "query", name: "Query" }],
    types: [
      { kind: "SCALAR", name: "ID" },
      { kind: "OBJECT", name: "Query" },
      { kind: "ENUM", name: "Role" },
    ],
  });
  assert(Object.isFrozen(summary.types));
  assert(Object.isFrozen(summary.roots[0]));
  const directory = createGraphQLSchemaDirectory();
  const sameKeyA = { id: "same" },
    sameKeyB = { id: "same" };
  directory.install(sameKeyA, summary);
  assert.equal(directory.get(sameKeyA), summary);
  assert.equal(directory.get(sameKeyB), undefined);
  assert(directory.clear(sameKeyA));
  assert.equal(directory.get(sameKeyA), undefined);
});

test("incomplete, malformed or oversized local Schema never becomes a type directory", () => {
  const cases = [
    { __schema: payload().data.__schema },
    { errors: [{ message: "partial" }], ...payload() },
    { errors: null, ...payload() },
    { data: { __schema: { types: [] } } },
    payload({ queryType: null }),
    payload({ queryType: { name: "Role" } }),
    payload({ mutationType: { name: "notListed" } }),
    payload({
      types: [
        { kind: "OBJECT", name: "Query" },
        { kind: "ENUM", name: "Query" },
      ],
    }),
    payload({
      types: [
        { kind: "OBJECT", name: "Query" },
        { kind: "CUSTOM", name: "Extended" },
      ],
    }),
    payload({
      types: [
        { kind: "OBJECT", name: "Query" },
        { kind: "OBJECT", name: "<img>" },
      ],
    }),
    payload({ types: new Array(2049).fill({ kind: "OBJECT", name: "Query" }) }),
  ];
  for (const doc of cases) assert.throws(() => read(doc), /Introspection JSON/);
  assert.throws(
    () => readLocalGraphQLSchema(utf8("type Query { id: ID! }")),
    /Introspection JSON/,
  );
  assert.throws(
    () => readLocalGraphQLSchema(Uint8Array.of(255)),
    /Introspection JSON/,
  );
  for (const bytes of [
    new Uint8Array(LOCAL_SCHEMA_LIMIT + 1),
    new Uint8Array(),
  ])
    assert.throws(() => readLocalGraphQLSchema(bytes), /2 MiB/);
});
