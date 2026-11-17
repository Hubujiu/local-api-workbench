import test from "node:test";
import assert from "node:assert/strict";
import { importPostmanGraphQLBody } from "../src/postman-graphql-body.mjs";
import {
  renderGraphQLVariableTemplate,
  validateGraphQLVariableTemplate,
} from "../src/graphql-variable-template.mjs";
import { normalizeRequest, interpolate } from "../src/core.mjs";
import { resolveDynamicRequest } from "../src/dynamic-values.mjs";
const make = (variables) =>
  importPostmanGraphQLBody({
    mode: "graphql",
    graphql: { query: "query($id:ID!){node(id:$id){id}}", variables },
  });
test("GraphQL complete string placeholders preserve nested values, escaped tokens and static numeric lexemes", async () => {
  const r = {
    ...make(
      '{"id":"\\u007b\\u007buser}}","nested":["{{user}}"],"large":9007199254740993}',
    ),
    url: "http://127.0.0.1:1/graphql",
    method: "POST",
  };
  assert.deepEqual(r.graphqlVariableTemplate, { version: 1 });
  const value = '"\\\n中{{must-stay-literal}}';
  const body = renderGraphQLVariableTemplate(r, { user: value });
  assert.equal(JSON.parse(body).variables.id, value);
  assert.equal(JSON.parse(body).variables.nested[0], value);
  assert.ok(body.includes("9007199254740993"));
  const before = structuredClone(r);
  const out = await resolveDynamicRequest(
    normalizeRequest(r),
    { user: value },
    [],
    interpolate,
  );
  assert.equal(out.body, body);
  assert.equal(Object.hasOwn(out, "graphqlVariableTemplate"), false);
  assert.deepEqual(r, before);
});
test("GraphQL template markers, static keys/query and ambiguous JSON cannot widen the contract", () => {
  for (const variables of [
    '{"id":"prefix{{user}}"}',
    '{"{{key}}":"x"}',
    '{"id":"{{user}}","id":"x"}',
    '{"id":"{{user}}","n":1e999}',
    '{"id":"{{user}}", "x":"{{bad name}}"}',
  ])
    assert.throws(() => make(variables), /GraphQL/);
  for (const mutate of [
    (r) => (r.graphqlVariableTemplate = null),
    (r) => (r.graphqlVariableTemplate = { version: 2 }),
    (r) => (r.graphqlVariableTemplate = { version: 1, extra: 1 }),
    (r) => (r.bodyType = "raw"),
    (r) => (r.bodyDynamic = { x: {} }),
    (r) =>
      (r.body =
        '{"query":"{{bad}}","query":"static","variables":{"x":"{{user}}"}}'),
  ]) {
    const r = make({ id: "{{user}}" });
    mutate(r);
    assert.throws(() => normalizeRequest(r), /GraphQL/);
  }
});
test("GraphQL templates reject missing/non-string values, getters and budgets without evaluating them", () => {
  const r = make({ id: "{{user}}" });
  let calls = 0;
  for (const vars of [
    {},
    { user: 1 },
    { user: null },
    { user: {} },
    { user: undefined },
    { user: "\ud800" },
    Object.create({ user: "inherited" }),
    Object.defineProperty({}, "user", {
      get() {
        calls++;
        return "bad";
      },
    }),
  ])
    assert.throws(() => renderGraphQLVariableTemplate(r, vars), /GraphQL/);
  assert.equal(calls, 0);
  assert.throws(
    () => renderGraphQLVariableTemplate(r, { user: "中".repeat(400000) }),
    /GraphQL/,
  );
  assert.throws(() =>
    make(
      Object.fromEntries(
        Array.from({ length: 101 }, (_, i) => ["k" + i, "{{user}}"]),
      ),
    ),
  );
  assert.throws(() =>
    validateGraphQLVariableTemplate({
      ...r,
      body: '{"query":"x","variables":{"v":"' + "x".repeat(1024 * 1024) + '"}}',
    }),
  );
});

test("GraphQL placeholder budget intersects active parameter work and existing per-value bytes", () => {
  const r = make({ id: "{{user}}" });
  assert.equal(
    JSON.parse(renderGraphQLVariableTemplate(r, { user: "x".repeat(65534) }))
      .variables.id.length,
    65534,
  );
  assert.throws(
    () => renderGraphQLVariableTemplate(r, { user: "x".repeat(65535) }),
    /GraphQL/,
  );
  r.query = Array.from({ length: 100 }, (_, i) => ({
    key: "q" + i,
    value: "",
    dynamic: { source: "fixed", value: "x" },
  }));
  assert.throws(() => validateGraphQLVariableTemplate(r), /GraphQL/);
  r.query[0].enabled = false;
  assert.equal(validateGraphQLVariableTemplate(r), true);
  const variables = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw Error("must not execute");
      },
    },
  );
  assert.throws(() => renderGraphQLVariableTemplate(r, variables), /GraphQL/);
});
