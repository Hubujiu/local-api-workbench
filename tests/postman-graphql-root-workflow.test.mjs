// Root intersections: static GraphQL payloads become ordinary JSON HTTP bodies.
// No GraphQL editor-mode fidelity, scripts, database execution or external peers.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store, executeRequest } from "../src/runtime.mjs";
import {
  importDocument,
  importIntoProject,
  snapshotPlan,
  runPlan,
  restoreProject,
} from "../src/core.mjs";
import { snapshotCase } from "../src/cases.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import { recordPlanRun } from "../src/plan-evidence.mjs";

const query = "query Echo($value: String!) { echo(value: $value) }";
const variables = ' { "value" : "中文\\nquoted\\\"", "count": 1e2 } ';
const expectedBody =
  '{"query":' +
  JSON.stringify(query) +
  ',"operationName":"Echo","variables":' +
  variables +
  "}";
function imported(port, endpoint, contentType) {
  return importDocument({
    info: {
      name: "GraphQL root",
      schema:
        "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: [
      {
        name: "GraphQL",
        request: {
          method: "POST",
          url: {
            protocol: "http",
            host: ["127", "0", "0", "1"],
            port: String(port),
            path: [endpoint],
            query: [{ key: "q", value: "a b" }],
          },
          ...(contentType
            ? { header: [{ key: "Content-Type", value: contentType }] }
            : {}),
          body: {
            mode: "graphql",
            graphql: { query, operationName: "Echo", variables },
          },
        },
      },
    ],
  })[0];
}
async function fixture(t) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({
      url: req.url,
      method: req.method,
      body: Buffer.concat(chunks),
      contentType: req.headers["content-type"],
    });
    if (req.url.startsWith("/start?"))
      res.writeHead(307, { location: "/middle" });
    else if (req.url === "/middle") res.writeHead(308, { location: "/final" });
    else res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(path.join(tmpdir(), "graphql-root-"));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { seen, port: server.address().port, root, store: new Store(root) };
}
function assertWire(records, contentType, body = expectedBody) {
  for (const record of records) {
    assert.equal(record.method, "POST");
    assert.deepEqual(record.body, Buffer.from(body));
    assert.equal(record.contentType, contentType);
    assert.deepEqual(JSON.parse(record.body), JSON.parse(body));
  }
}

test("structured Postman GraphQL import freezes explicitly saved redirect policy; 307/308 retain exact bytes and restore does not replay", async (t) => {
  const { seen, port, store, root } = await fixture(t);
  const project = await store.create("GraphQL redirect");
  const request = imported(port, "start");
  assert.equal(request.bodyType, "json");
  assert.equal(request.body, expectedBody);
  assert.notEqual(request.redirect?.mode, "same-origin");
  // Redirect is explicitly enabled after import, never inferred from Postman.
  request.redirect = { mode: "same-origin", maxHops: 5 };
  project.requests = [request];
  project.plans = [
    snapshotPlan({
      id: "frozen",
      name: "Frozen GraphQL",
      steps: [{ id: "step", request }],
    }),
  ];
  await store.save(project);
  const changed = await store.get(project.id);
  changed.requests[0].url = `http://127.0.0.1:${port}/live`;
  changed.requests[0].body = '{"query":"query Live { live }"}';
  await store.save(changed);
  const disk = await new Store(root).get(project.id);
  const run = await runPlan(disk.plans[0], {}, executeRequest);
  assert.equal(run.status, "passed");
  assert.deepEqual(
    seen.map((r) => r.url),
    ["/start?q=a+b", "/middle", "/final"],
  );
  assertWire(seen, "application/json");
  assert.equal(run.results[0].response.status, 200);
  assert.deepEqual(
    run.results[0].response.redirectTrace.map((hop) => hop.status),
    [307, 308, 200],
  );
  await recordPlanRun(store, project.id, run, "mcp");
  const backup = await new Store(root).get(project.id);
  const restored = restoreProject(JSON.parse(JSON.stringify(backup)));
  await store.save(restored);
  assert.equal(
    seen.length,
    3,
    "persisting and restoring completed evidence must not replay HTTP",
  );
  const recovered = await new Store(root).get(restored.id);
  assert.equal(backup.runs.length, 1);
  assert.deepEqual(recovered.runs, backup.runs);
  assert.equal(recovered.runs[0].results[0].response.status, 200);
  assert.equal(recovered.plans[0].steps[0].request.body, expectedBody);
  assert.equal(recovered.requests[0].body, changed.requests[0].body);
  assert.throws(() => exportApipostDirectory(recovered), /redirect/);
  const replay = await runPlan(recovered.plans[0], {}, executeRequest);
  assert.equal(replay.status, "passed");
  assert.equal(seen.length, 6, "only explicit plan execution sends again");
  assertWire(seen.slice(3), "application/json");
});

for (const format of ["json-case", "directory-flow"])
  test(`GraphQL ordinary JSON HTTP semantics roundtrip through Apipost ${format}, persistence and restore`, async (t) => {
    const { seen, port, store, root } = await fixture(t);
    const source = await store.create("GraphQL native interchange");
    const request = imported(port, "echo", "application/graphql-response+json");
    source.requests = [request];
    // Independent definition without redirect: never strip policy to defeat export guards.
    assert.notEqual(request.redirect?.mode, "same-origin");
    if (format === "json-case")
      source.cases = [
        snapshotCase({
          id: "case",
          name: "GraphQL",
          sourceRequestId: request.id,
          request,
        }),
      ];
    else
      source.plans = [
        snapshotPlan({
          id: "flow",
          name: "GraphQL flow",
          statusPolicy: "strict200",
          environmentId: source.environments[0].id,
          steps: [{ id: "step", name: "GraphQL", request }],
        }),
      ];
    // Live editing must not rewrite a frozen case/flow payload.
    source.requests[0].body = '{"query":"query Live { live }"}';
    const before = structuredClone(source);
    const document =
      format === "json-case"
        ? exportApipost(source)
        : exportApipostDirectory(source);
    assert.deepEqual(source, before);
    assert.equal(seen.length, 0);
    const target = await store.create("Reimported");
    target.environments = [];
    importIntoProject(target, document);
    await store.save(target);
    const disk = await new Store(root).get(target.id);
    const restored = restoreProject(JSON.parse(JSON.stringify(disk)));
    await store.save(restored);
    assert.equal(seen.length, 0, "definition import/restore is inert");
    for (const current of [disk, await new Store(root).get(restored.id)]) {
      assert.equal(current.requests[0].body, source.requests[0].body);
      if (format === "json-case") {
        assert.equal(current.cases.length, 1);
        assert.equal(current.cases[0].request.bodyType, "json");
        assert.equal(
          (await executeRequest(current.cases[0].request)).status,
          200,
        );
      } else {
        assert.equal(current.plans.length, 1);
        assert.equal(
          (await runPlan(current.plans[0], {}, executeRequest)).status,
          "passed",
        );
      }
    }
    assert.equal(seen.length, 2);
    assertWire(seen, "application/graphql-response+json");
  });
