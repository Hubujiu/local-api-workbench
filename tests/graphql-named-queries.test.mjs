import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newGraphQLEditorRequest,
  prepareGraphQLEdit,
} from "../public/graphql-editor.js";
import {
  assertStoredGraphQLNamedQueries,
  GRAPHQL_NAMED_QUERY_LIMIT,
  normalizeGraphQLNamedQueries,
  prepareGraphQLNamedQueryChange as change,
  readGraphQLNamedQueries,
} from "../public/graphql-named-queries.js";
import {
  interpolate,
  normalizeRequest,
  prepareLiteralHTTPExport,
  snapshotPlan,
  toCurl,
  exportOpenAPI,
} from "../src/core.mjs";
import { snapshotCase } from "../src/cases.mjs";
import { resolveDynamicRequest } from "../src/dynamic-values.mjs";
import { Store } from "../src/runtime.mjs";

const first =
  ' \n{ "query":"query FirstFixture { role }","variables":\r\n{"large":90071992547409929,"negative":-0,"escaped":"\\u0041"} }\t';
const original = () => ({
  ...newGraphQLEditorRequest(),
  id: "gql",
  name: "GraphQL fixture",
  url: "http://127.0.0.1:1/not-called",
  body: first,
});
const apply = (request, type, id, name) => ({
  ...request,
  ...change(request, name === undefined ? { type, id } : { type, id, name }),
});
const named = () => apply(original(), "add", "second", "Second Fixture");

test("legacy requests gain no collection until an explicit successful action", () => {
  const request = original();
  assert.equal(normalizeGraphQLNamedQueries(request), undefined);
  assert.equal(
    readGraphQLNamedQueries({ ...request, graphqlEditorVersion: undefined }),
    null,
  );
  assert.deepEqual(readGraphQLNamedQueries(request), {
    activeId: "default",
    items: [{ id: "default", name: "自定义查询" }],
  });
  assert.equal(change(request, { type: "select", id: "default" }), null);
  assert.throws(
    () => change(request, { type: "delete", id: "default" }),
    /至少保留/,
  );
  assert.equal(Object.hasOwn(request, "graphqlNamedQueries"), false);
  assert.equal(request.body, first);
  const r = apply(request, "rename", "default", "First");
  assert.equal(r.body, first);
  assert.deepEqual(r.graphqlNamedQueries.items, [
    { id: "default", name: "First" },
  ]);
});

test("each switch preserves exact inactive bytes and does not duplicate active body; rename is metadata only", () => {
  const second = named();
  assert.equal(second.body, '{"query":""}');
  second.body = prepareGraphQLEdit(second, {
    query: "query Second { role }",
    variablesSource: "null",
    operationName: "Second",
  });
  const secondBody = second.body;
  assert.deepEqual(second.graphqlNamedQueries, {
    version: 1,
    activeId: "second",
    items: [
      { id: "default", name: "自定义查询", body: first },
      { id: "second", name: "Second Fixture" },
    ],
  });
  const activeFirst = apply(second, "select", "default");
  assert.equal(activeFirst.body, first);
  assert.deepEqual(activeFirst.graphqlNamedQueries.items, [
    { id: "default", name: "自定义查询" },
    { id: "second", name: "Second Fixture", body: secondBody },
  ]);
  const renamed = apply(activeFirst, "rename", "second", "Renamed only");
  assert.equal(renamed.body, first);
  assert.equal(renamed.graphqlNamedQueries.items[1].body, secondBody);
  assert.equal(second.graphqlNamedQueries.items[1].name, "Second Fixture");
  assert.equal(renamed.graphqlNamedQueries.items[1].name, "Renamed only");
  const activeSecond = apply(renamed, "select", "second");
  assert.equal(activeSecond.body, secondBody);
  assert(!Object.hasOwn(activeSecond.graphqlNamedQueries.items[1], "body"));
  const afterDelete = apply(activeSecond, "delete", "second");
  assert.equal(afterDelete.body, first);
  assert.deepEqual(afterDelete.graphqlNamedQueries.items, [
    { id: "default", name: "自定义查询" },
  ]);
  const removeInactive = apply(activeSecond, "delete", "default");
  assert.equal(removeInactive.body, secondBody);
  assert.deepEqual(removeInactive.graphqlNamedQueries.items, [
    { id: "second", name: "Renamed only" },
  ]);
  assert.throws(
    () => change(afterDelete, { type: "delete", id: "default" }),
    /至少保留/,
  );
});

test("malformed ownership, bounds and unsupported envelopes fail without editing or silently dropping content", () => {
  const accepted = named();
  const bad = (edit) => {
    const fixture = structuredClone(accepted);
    edit(fixture);
    return fixture;
  };
  for (const fixture of [
    bad((r) => {
      r.graphqlNamedQueries.version = 2;
    }),
    bad((r) => {
      r.graphqlNamedQueries.activeId = "not-a-row";
    }),
    bad((r) => {
      r.graphqlNamedQueries.items[1].body = first;
    }),
    bad((r) => {
      delete r.graphqlNamedQueries.items[0].body;
    }),
    bad((r) => {
      r.graphqlNamedQueries.items[0].id = "second";
    }),
    bad((r) => {
      r.graphqlNamedQueries.items[0].name = " ";
    }),
    bad((r) => {
      r.graphqlNamedQueries.items[0].body = "中".repeat(800_000);
    }),
    bad((r) => {
      delete r.graphqlEditorVersion;
    }),
  ])
    assert.throws(() => normalizeRequest(fixture), /GraphQL/);
  const badBody = bad((r) => {
    r.graphqlNamedQueries.items[0].body =
      '{"query":"secret unsupported","extensions":{}}';
  });
  assert.throws(() => assertStoredGraphQLNamedQueries(badBody), /GraphQL/);
  assert.throws(
    () => change(badBody, { type: "select", id: "default" }),
    (err) => /GraphQL/.test(err.message) && !err.message.includes("secret"),
  );
  const activeBad = bad((r) => {
    r.body = '{"query":"own","extensions":{}}';
  });
  assert.equal(readGraphQLNamedQueries(activeBad), null);
  assert.equal(normalizeRequest(activeBad).body, activeBad.body);
  assert.throws(
    () => change(activeBad, { type: "add", id: "third", name: "Third" }),
    /GraphQL/,
  );
  const full = bad((r) => {
    const { items } = r.graphqlNamedQueries;
    for (let i = items.length; i < GRAPHQL_NAMED_QUERY_LIMIT; i++)
      items.push({ id: "item-" + i, name: "Item " + i, body: '{"query":""}' });
  });
  assert.equal(
    readGraphQLNamedQueries(full).items.length,
    GRAPHQL_NAMED_QUERY_LIMIT,
  );
  assert.throws(
    () => change(full, { type: "add", id: "overflow", name: "Extra" }),
    /32/,
  );
  assert.equal(accepted.body, '{"query":""}');
});

test("saved local definitions, explicit clones and backups retain both variants; frozen projections contain only active bytes", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "workbench-graphql-named-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new Store(home);
  const project = await store.create("Named queries isolated fixture");
  const request = named();
  request.body = '{"query":"query Visible { role }","variables":null}';
  const clone = normalizeRequest({ ...structuredClone(request), id: "clone" });
  assert.deepEqual(clone.graphqlNamedQueries, request.graphqlNamedQueries);
  assert.notEqual(clone.graphqlNamedQueries, request.graphqlNamedQueries);
  const plan = snapshotPlan({ name: "Active query", steps: [{ request }] });
  const example = snapshotCase({
    name: "Active variant",
    sourceRequestId: request.id,
    request,
  });
  const literal = prepareLiteralHTTPExport(request);
  const resolved = await resolveDynamicRequest(
    request,
    {},
    [],
    (value, vars) => {
      if (value && typeof value === "object")
        assert.equal(Object.hasOwn(value, "graphqlNamedQueries"), false);
      return interpolate(value, vars);
    },
  );
  for (const projection of [
    plan.steps[0].request,
    example.request,
    literal.request,
    resolved,
  ]) {
    assert.equal(projection.body, request.body);
    assert.equal(Object.hasOwn(projection, "graphqlNamedQueries"), false);
    assert(!JSON.stringify(projection).includes("FirstFixture"));
  }
  assert(!toCurl(request).includes("FirstFixture"));
  assert(
    !JSON.stringify(
      exportOpenAPI({
        name: project.name,
        requests: [normalizeRequest(request)],
      }),
    ).includes("FirstFixture"),
  );
  project.requests = [request, clone];
  project.plans = [plan];
  project.cases = [example];
  await store.save(project);
  const saved = await new Store(home).get(project.id);
  assert.equal(saved.requests[0].body, request.body);
  assert.equal(saved.requests[0].graphqlNamedQueries.items[0].body, first);
  assert.equal(saved.requests[1].graphqlNamedQueries.items[0].body, first);
  const restore = await store.restore(JSON.stringify(saved));
  assert.notEqual(restore.id, saved.id);
  assert.deepEqual(
    restore.requests[0].graphqlNamedQueries,
    saved.requests[0].graphqlNamedQueries,
  );
  assert.equal(restore.requests[0].body, request.body);
  assert.equal(restore.plans[0].steps[0].request.body, request.body);
  assert(
    !Object.hasOwn(restore.plans[0].steps[0].request, "graphqlNamedQueries"),
  );
  const invalid = await store.get(project.id);
  invalid.requests[0].graphqlNamedQueries.items[0].body =
    '{"query":"x","extensions":{}}';
  await assert.rejects(store.save(invalid), /GraphQL/);
  assert.deepEqual(
    (await store.get(project.id)).requests[0].graphqlNamedQueries,
    saved.requests[0].graphqlNamedQueries,
  );
});
