import assert from "node:assert/strict";
import test from "node:test";
import { newGraphQLEditorRequest } from "../public/graphql-editor.js";
import { snapshotPlan } from "../src/core.mjs";
import { materializeLivePlan } from "../src/live-plan-materialize.mjs";
import { createMCP } from "../src/mcp.mjs";

const canonical = '{"query":"query Selected { role }","variables":{"n":-0}}';
const inactiveBody = (padding = "") =>
  JSON.stringify({
    query: "query InactiveFixture { role }",
    variables: { padding },
  });
const request = (padding = "") => ({
  ...newGraphQLEditorRequest(),
  id: "graphql-fixture",
  name: "Synthetic active projection",
  url: "http://127.0.0.1:1/never-executed",
  body: canonical,
  graphqlNamedQueries: {
    version: 1,
    activeId: "selected",
    items: [
      { id: "selected", name: "Selected title" },
      { id: "inactive", name: "Inactive title", body: inactiveBody(padding) },
    ],
  },
});
const project = (gql) => ({
  id: "p",
  requests: [gql, { ...gql, id: "deleted", deletedAt: "fixture" }],
  documents: [{ id: "doc", title: "Ordinary doc", content: "fixture" }],
  protocols: [{ id: "sse", name: "Ordinary SSE", url: gql.url, type: "sse" }],
  environments: [{ id: "env", name: "fixture", variables: {} }],
  settings: {},
});

test("actual in-process MCP detail is active-only while scopes, ordering and owner object stay intact", async () => {
  const owned = project(request());
  let reads = 0;
  const store = {
    async get(id) {
      assert.equal(id, owned.id);
      reads++;
      return owned;
    },
  };
  const dispatcher = createMCP({ store, projects: [owned.id] });
  const denied = createMCP({ store, projects: [] });
  const detail = (agent, apiId) =>
    agent({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "localapi_get_api_detail",
        arguments: { projectId: owned.id, apiId },
      },
    });
  const result = await detail(dispatcher, owned.requests[0].id);
  assert(!result.result.isError);
  const text = result.result.content[0].text;
  const actual = JSON.parse(text);
  assert.equal(actual.body, canonical);
  assert.equal(actual.graphqlEditorVersion, 1);
  assert(!Object.hasOwn(actual, "graphqlNamedQueries"));
  assert(!text.includes("InactiveFixture") && !text.includes("Inactive title"));
  assert.equal(
    owned.requests[0].graphqlNamedQueries.items[1].body,
    inactiveBody(),
  );
  for (const [id, expected] of [
    ["sse", owned.protocols[0]],
    ["doc", owned.documents[0]],
  ])
    assert.deepEqual(
      JSON.parse((await detail(dispatcher, id)).result.content[0].text),
      expected,
    );
  assert((await detail(dispatcher, "deleted")).result.isError);
  assert((await detail(denied, owned.requests[0].id)).result.isError);
  assert.equal(reads, 4);
});

test("live plan counts only the frozen GraphQL body, leaving source/active budgets intact", () => {
  const gql = request("fixture ".repeat(100000));
  const owned = project(gql);
  const plan = snapshotPlan({
    id: "plan",
    steps: Array.from({ length: 6 }, (_, index) => ({
      id: "step-" + index,
      liveRequestId: gql.id,
      request: {
        url: gql.url,
        method: "POST",
        bodyType: "json",
        body: '{"query":"old"}',
      },
    })),
  });
  assert(
    Buffer.byteLength(gql.graphqlNamedQueries.items[1].body) * 6 >
      4 * 1024 * 1024,
  );
  const frozen = materializeLivePlan(owned, plan);
  assert.equal(frozen.bindings.length, 6);
  for (const { request: step, liveRequestId } of frozen.plan.steps) {
    assert.equal(liveRequestId, undefined);
    assert.equal(step.body, canonical);
    assert(!Object.hasOwn(step, "graphqlNamedQueries"));
  }
  assert.equal(
    owned.requests[0].graphqlNamedQueries.items[1].body,
    gql.graphqlNamedQueries.items[1].body,
  );

  const largeActive = { ...gql, body: inactiveBody("fixture ".repeat(100000)) };
  assert.throws(
    () => materializeLivePlan(project(largeActive), plan),
    /冻结快照超过 4 MiB/,
  );
});
