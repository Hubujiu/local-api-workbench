import assert from "node:assert/strict";
import test from "node:test";
import {
  canEditDebugURLQuery,
  changeDebugURLQueryValue,
  debugURLQueryBlankState,
  debugURLQueryContents,
  expireLiteralURLQueryRows,
  inspectDebugURLQuery,
  setDebugURLQueryBlankEquality,
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

test("literal blank equality only changes empty tokens and preserves spelling through cURL", () => {
  const initial = raw.replace("&flag", "&kept==&encoded=%20&low=%2b&flag");
  const all = initial.replace("&flag&", "&flag=&");
  const none = initial.replace("&empty=", "&empty");
  assert.equal(debugURLQueryBlankState(inspectDebugURLQuery(initial)), "mixed");
  assert.equal(setDebugURLQueryBlankEquality(initial, true), all);
  assert.equal(setDebugURLQueryBlankEquality(initial, false), none);
  assert.equal(debugURLQueryBlankState(inspectDebugURLQuery(all)), "true");
  assert.equal(debugURLQueryBlankState(inspectDebugURLQuery(none)), "false");
  assert.equal(setDebugURLQueryBlankEquality(all, false), none);
  assert.equal(setDebugURLQueryBlankEquality(none, true), all);
  assert.equal(setDebugURLQueryBlankEquality(none, "false"), null);
  const justNonempty = "https://fixture.invalid/items?space=%20&extra==#";
  assert.equal(setDebugURLQueryBlankEquality(justNonempty, true), justNonempty);
  assert.equal(
    debugURLQueryBlankState(inspectDebugURLQuery(justNonempty)),
    null,
  );
  for (const opaque of [
    "/items?flag",
    "https://fixture.invalid/items?flag&",
    "https://fixture.invalid/items?flag&value={{user}}",
  ])
    assert.equal(setDebugURLQueryBlankEquality(opaque, false), null);
  const appendix = [{ key: "table", value: "", enabled: true }];
  const url = new URL(none);
  const wire = appendRequestQuery(url, appendix, true).href;
  assert.equal(wire, none.replace("#part", "&table=#part"));
  assert(
    toCurl({
      method: "GET",
      url: none,
      query: appendix,
      queryAddEqual: true,
    }).includes(wire),
  );
});

test("all-off projection remains restorable but sparse stale or degraded editor is not actionable", () => {
  const request = {
    id: "a",
    query: [],
    url: "https://fixture.invalid/items#part",
  };
  const project = {
    id: "example",
    requests: [request],
    literalQueryEditor: {
      version: 1,
      projectId: "example",
      entries: [
        {
          requestId: "a",
          effectiveURL: request.url,
          rows: [
            { token: "tag=a%2Bb", enabled: false },
            { token: "tag=a+b", enabled: false },
          ],
        },
      ],
    },
  };
  const html = debugURLQueryContents(project, request, String);
  assert.match(html, /启用 URL 查询项 2：tag/);
  assert.match(html, /value="a\+b" readonly/);
  assert.doesNotMatch(
    html,
    /data-debug-literal-query-enabled="\d"[^>]*checked/,
  );
  request.url = "https://fixture.invalid/items?other=1";
  assert.equal(expireLiteralURLQueryRows(project, request), true);
  request.url = "https://fixture.invalid/items#part";
  assert.equal(debugURLQueryContents(project, request, String), "");
  assert.deepEqual(project.literalQueryEditor.entries, []);
  const degraded = { ...project, literalQueryEditorIssue: "invalid" };
  request.url = "https://fixture.invalid/items?other=1";
  const recovery = debugURLQueryContents(degraded, request, String);
  assert.match(recovery, /本地保留的未启用查询项暂不可读/);
  assert.doesNotMatch(recovery, /data-debug-literal-query-enabled/);
  assert.match(recovery, /value="1">/);
});
