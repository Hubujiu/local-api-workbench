import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { importPostmanGraphQLBody } from "../src/postman-graphql-body.mjs";
import { importDocument } from "../src/core.mjs";
import { executeRequest } from "../src/runtime.mjs";
const query = 'query Echo($id: ID!) { echo(id: $id) }\n# 中文 "quoted"';
const definition = (graphql, extra = {}) => ({
  mode: "graphql",
  graphql,
  ...extra,
});
const collection = (body, header = [], url = "http://127.0.0.1:9/graphql") => ({
  info: { name: "GraphQL" },
  item: [{ name: "Echo", request: { method: "POST", url, header, body } }],
});

test("GraphQL static variables preserve omitted/null/object/string JSON meaning and exact serialized numeric lexemes", () => {
  const cases = [
    [{ query }, { query }],
    [{ query, variables: "" }, { query }],
    [
      { query, variables: null },
      { query, variables: null },
    ],
    [
      {
        query,
        variables: { id: "abc", list: [1, true, null], nested: { a: "é" } },
      },
      {
        query,
        variables: { id: "abc", list: [1, true, null], nested: { a: "é" } },
      },
    ],
    [
      { query, operationName: "Echo", variables: ' { "id":"abc" } ' },
      { query, operationName: "Echo", variables: { id: "abc" } },
    ],
    [
      { query, variables: "null" },
      { query, variables: null },
    ],
  ];
  for (const [input, expected] of cases) {
    const before = structuredClone(input);
    const result = importPostmanGraphQLBody(definition(input));
    assert.equal(result.bodyType, "json");
    assert.deepEqual(JSON.parse(result.body), expected);
    assert.deepEqual(input, before);
    assert.deepEqual(
      JSON.parse(importDocument(collection(definition(input)))[0].body),
      expected,
    );
  }
  const original =
    ' {"large":9007199254740993,"tiny":1e-30,"__proto__":{"safe":true}} ';
  const result = importPostmanGraphQLBody(
    definition({ query, variables: original }),
  );
  assert(result.body.includes('"variables":' + original));
  assert.equal(Object.prototype.safe, undefined);
});

test("GraphQL unsupported dynamic and malformed definitions reject instead of dropping the body", () => {
  const bad = [
    undefined,
    null,
    [],
    {},
    { query: 12 },
    { query, operationName: null },
    { query, variables: [] },
    { query, variables: 1 },
    { query, variables: true },
    { query, variables: "[]" },
    { query, variables: "true" },
    { query, variables: '"a"' },
    { query, variables: "{" },
    { query, variables: " " },
    { query, variables: undefined },
    { query, extra: "discarded" },
    { query: "{{query}}" },
    { query, operationName: "{{op}}" },
    { query, variables: { "{{key}}": 1 } },
    { query, variables: { x: ["{{nested}}"] } },
    { query, variables: '{"x":"\\u007b\\u007bsecret}}"}' },
    { query, variables: '{"x":"\\u007b\\u007bsecret}}","x":"static"}' },
    { query, variables: { x: Infinity } },
    { query, variables: { x: undefined } },
  ];
  for (const value of bad)
    assert.throws(() => importPostmanGraphQLBody(definition(value)), /GraphQL/);
  assert.throws(
    () => importPostmanGraphQLBody(definition({ query }, { disabled: "true" })),
    /GraphQL/,
  );
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => importPostmanGraphQLBody(definition({ query, variables: cyclic })),
    /GraphQL/,
  );
  const deep = {};
  let cursor = deep;
  for (let i = 0; i < 70; i++) cursor = cursor.next = {};
  assert.throws(
    () => importPostmanGraphQLBody(definition({ query, variables: deep })),
    /GraphQL/,
  );
});

test("GraphQL adapter does not invoke getters, proxies or toJSON hooks", () => {
  let calls = 0;
  for (const value of [
    {
      get query() {
        calls++;
        return query;
      },
    },
    {
      query,
      variables: {
        get value() {
          calls++;
          return "x";
        },
      },
    },
    {
      query,
      variables: {
        toJSON() {
          calls++;
          return {};
        },
      },
    },
    new Proxy(
      { query },
      {
        ownKeys() {
          calls++;
          return [];
        },
      },
    ),
  ])
    assert.throws(() => importPostmanGraphQLBody(definition(value)), /GraphQL/);
  assert.equal(calls, 0);
  const inherited = Object.create({ query });
  assert.throws(
    () => importPostmanGraphQLBody(definition(inherited)),
    /GraphQL/,
  );
});

test("GraphQL disabled body is ignored without parsing and legacy raw imports retain behavior", () => {
  assert.deepEqual(
    importPostmanGraphQLBody(
      definition({ query: 12, variables: "{{bad}}" }, { disabled: true }),
    ),
    { bodyType: "none", body: "" },
  );
  const [disabled] = importDocument(
    collection(definition(null, { disabled: true })),
  );
  assert.equal(disabled.bodyType, "none");
  assert.equal(disabled.body, "");
  const [raw] = importDocument(collection({ mode: "raw", raw: "plain" }));
  assert.equal(raw.bodyType, "raw");
  assert.equal(raw.body, "plain");
});

test("GraphQL actual HTTP preserves payload, explicit/disabled/default Content-Type and disabled-body wire behavior", async (t) => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method, body, type: req.headers["content-type"] });
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const url = `http://127.0.0.1:${server.address().port}/graphql`;
  const headers = [
    [],
    [{ key: "Content-Type", value: "application/graphql+json" }],
    [{ key: "content-type", value: "" }],
    [{ key: "Content-Type", value: "ignored", disabled: true }],
  ];
  for (const header of headers)
    await executeRequest(
      importDocument(
        collection(
          definition({
            query,
            operationName: "Echo",
            variables: '{"id":"abc"}',
          }),
          header,
          url,
        ),
      )[0],
    );
  await executeRequest(
    importDocument(
      collection(definition(null, { disabled: true }), [], url),
    )[0],
  );
  assert.deepEqual(
    seen.map((x) => x.type),
    [
      "application/json",
      "application/graphql+json",
      "",
      "application/json",
      undefined,
    ],
  );
  for (const row of seen.slice(0, 4)) {
    assert.equal(row.method, "POST");
    assert.deepEqual(JSON.parse(row.body), {
      query,
      operationName: "Echo",
      variables: { id: "abc" },
    });
  }
  assert.equal(seen[4].body, "");
});

test("GraphQL snapshots never invoke inherited serialization hooks", () => {
  let calls = 0;
  const arrayHook = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
  const objectHook = Object.getOwnPropertyDescriptor(
    Object.prototype,
    "toJSON",
  );
  let result;
  try {
    for (const prototype of [Array.prototype, Object.prototype])
      Object.defineProperty(prototype, "toJSON", {
        configurable: true,
        value() {
          calls++;
          return "changed";
        },
      });
    result = importPostmanGraphQLBody(
      definition({ query, variables: { items: [1] } }),
    );
  } finally {
    for (const [prototype, descriptor] of [
      [Array.prototype, arrayHook],
      [Object.prototype, objectHook],
    ]) {
      if (descriptor) Object.defineProperty(prototype, "toJSON", descriptor);
      else delete prototype.toJSON;
    }
  }
  assert.equal(calls, 0);
  assert.deepEqual(JSON.parse(result.body), {
    query,
    variables: { items: [1] },
  });
});
