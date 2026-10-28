import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  importIntoProject,
  snapshotPlan,
  restoreProject,
} from "../src/core.mjs";
import { createApp } from "../src/server.mjs";
import { nativeMongoFixture } from "./fixtures/apipost-mongodb.mjs";

// Definition-only tests: no request, script VM or database execution.
const intended = "9007199254740993";
const invalidQueries = [
  '{"id":9007199254740993}',
  '{"id":{"$numberLong":"9223372036854775808"}}',
  '{"id":{"$numberLong":"-9223372036854775809"}}',
  '{"id":{"$numberLong":"1","extra":2}}',
];
const unsafeSource = (query = invalidQueries[0]) => {
  const source = nativeMongoFixture("http://127.0.0.1:1/must-not-execute");
  source.apis
    .find((node) => node.target_type === "api")
    .request.pre_tasks.find((task) => task.type === "database").data.query =
    query;
  return source;
};
const operation = (request) =>
  request.nativeTasks.before.find((task) => task.type === "database").data;
const assertExact = (request) => {
  assert.deepEqual(JSON.parse(operation(request).query).filter, {
    id: { $numberLong: intended },
  });
  assert.equal(operation(request).variables[0].pattern, "$.id.$numberLong");
};

test("native Mongo query text rejects an unsafe integer without mutating source or project", () => {
  for (const query of invalidQueries) {
    const source = unsafeSource(query),
      beforeSource = structuredClone(source);
    const project = { requests: [], environments: [], settings: {} },
      before = structuredClone(project);
    assert.throws(
      () => importIntoProject(project, source),
      /安全精度|numberLong/,
    );
    assert.deepEqual(project, before);
    assert.deepEqual(source, beforeSource);
  }
});

test("owner native import is atomic and exact EJSON survives save, frozen plan, restore and restart without execution", async (t) => {
  const root = await mkdtemp(
    join(tmpdir(), "native-mongo-precision-definition-"),
  );
  let app = await createApp({ root, port: 0 });
  const stop = async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    await stop();
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("Exact native definition");
  const other = await app.store.create("Untouched neighbor");
  const before = await app.store.get(project.id);
  const upload = (document) =>
    fetch(app.url + `/api/projects/${project.id}/import`, {
      method: "POST",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ document }),
    });
  for (const query of invalidQueries) {
    const rejected = await upload(unsafeSource(query));
    assert.equal(rejected.status, 400);
    assert.match(await rejected.text(), /安全精度|numberLong/);
    assert.deepEqual(await app.store.get(project.id), before);
    assert.deepEqual(await app.store.get(other.id), other);
  }
  const source = nativeMongoFixture("http://127.0.0.1:1/must-not-execute", {
    filter: { id: { $numberLong: intended } },
    pattern: "$.id.$numberLong",
  });
  const sourceBefore = structuredClone(source);
  const accepted = await upload(source);
  assert.equal(accepted.status, 200, await accepted.clone().text());
  const saved = await app.store.get(project.id);
  assertExact(saved.requests[0]);
  saved.plans = [
    snapshotPlan({ id: "exact", steps: [{ request: saved.requests[0] }] }),
  ];
  assertExact(saved.plans[0].steps[0].request);
  await app.store.save(saved);
  const restored = restoreProject(
    JSON.stringify(await app.store.get(project.id)),
  );
  assertExact(restored.requests[0]);
  assertExact(restored.plans[0].steps[0].request);
  await app.store.save(restored);
  await stop();
  app = await createApp({ root, port: 0 });
  for (const id of [project.id, restored.id]) {
    const persisted = await app.store.get(id);
    assertExact(persisted.requests[0]);
    assertExact(persisted.plans[0].steps[0].request);
    assert.deepEqual(persisted.runs, []);
  }
  assert.deepEqual(await app.store.get(other.id), other);
  assert.deepEqual(source, sourceBefore);
});
