import assert from "node:assert/strict";
import test from "node:test";
import {
  canEditDebugURLQuery,
  changeDebugURLQueryValue,
  inspectDebugURLQuery,
} from "../public/debug-url-query.js";
import { appendRequestQuery } from "../src/query-serialization.mjs";
import { applyGlobalParameters } from "../src/global-parameters.mjs";
import { importDocument, toCurl } from "../src/core.mjs";

const raw = "https://fixture.invalid/items?tag=a%2Bb&tag=a+b&flag&empty=#part";
const updated =
  "https://fixture.invalid/items?tag=ui%2Bnext&tag=a+b&flag&empty=#part";

test("projection keeps individual occurrences and lexically distinct plus and blank fields", () => {
  const parsed = inspectDebugURLQuery(raw);
  assert.deepEqual(parsed.rows, [
    { key: "tag", value: "a%2Bb", equals: true },
    { key: "tag", value: "a+b", equals: true },
    { key: "flag", value: "", equals: false },
    { key: "empty", value: "", equals: true },
  ]);
  assert.equal(changeDebugURLQueryValue(raw, 0, "ui%2Bnext"), updated);
  assert.equal(changeDebugURLQueryValue(raw, 2, ""), raw);
  assert.equal(
    changeDebugURLQueryValue(raw, 1, "%2f=x"),
    "https://fixture.invalid/items?tag=a%2Bb&tag=%2f=x&flag&empty=#part",
  );
  for (const value of ["a&b", "#", "%", "%2", "literal space", "{{name}}"])
    assert.equal(changeDebugURLQueryValue(raw, 0, value), null, value);
});

test("ambiguous syntax and imported schemas are not editable", () => {
  for (const raw of [
    "/items?tag=x",
    "https://fixture.invalid/items?tag={{x}}",
    "https://fixture.invalid/items?tag=x&",
    "https://fixture.invalid/items?=x",
    "https://fixture.invalid/items?tag=%2",
    "https://user@fixture.invalid/items?tag=x",
    "https://fixture.invalid/items?tag=x#{{fragment}}",
  ]) {
    assert.deepEqual(inspectDebugURLQuery(raw), { opaque: true });
    assert.equal(changeDebugURLQueryValue(raw, 0, "x"), null);
  }
  const request = { query: [], folder: "a" };
  assert.equal(canEditDebugURLQuery({}, request), true);
  for (const patch of [
    { scriptURLMode: "sdk" },
    { sourceOperationId: "apipost:fixture" },
    { postmanCollectionId: "fixture" },
    { serviceId: "fixture" },
    { graphqlEditorVersion: 1 },
    { query: [{ reservedQuerySerialization: {} }] },
  ])
    assert.equal(canEditDebugURLQuery({}, { ...request, ...patch }), false);
  const [openapi] = importDocument({
    openapi: "3.0.0",
    info: { title: "Fixture", version: "1" },
    paths: { "/items": { get: { responses: { 200: { description: "OK" } } } } },
  });
  assert.equal(openapi.sourceOperationId, "");
  assert.equal(canEditDebugURLQuery({}, openapi), false);
  assert.equal(
    canEditDebugURLQuery({ settings: { folderServices: { a: "s" } } }, request),
    false,
  );
});

test("existing runtime and cURL get one literal edit; table keys and inheritance stay independent", () => {
  const project = {
    settings: {
      globalParameters: {
        query: [{ key: "tag", value: "inherited", enabled: true }],
      },
    },
  };
  const query = [
    { key: "blank", value: "", enabled: true },
    { key: "disabled", value: "skip", enabled: false },
  ];
  const request = { method: "GET", url: raw, query, queryAddEqual: false };
  const next = {
    ...request,
    url: changeDebugURLQueryValue(raw, 0, "ui%2Bnext"),
  };
  assert.equal(next.query, query);
  const before = applyGlobalParameters(project, request);
  const after = applyGlobalParameters(project, next);
  assert.deepEqual(before.query, after.query);
  const expected =
    "https://fixture.invalid/items?tag=ui%2Bnext&tag=a+b&flag&empty=&tag=inherited&blank#part";
  assert.equal(
    appendRequestQuery(new URL(after.url), after.query, after.queryAddEqual)
      .href,
    expected,
  );
  assert(toCurl(after).includes(expected));
  assert.equal(request.url, raw);
});
