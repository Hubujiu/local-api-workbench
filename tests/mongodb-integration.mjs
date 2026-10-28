import assert from "node:assert/strict";
import { queryRemoteDatabase } from "../src/remote-database.mjs";
const run = (query) =>
  queryRemoteDatabase({
    type: "mongodb",
    host: "127.0.0.1",
    port: 27017,
    database: "fixture",
    query,
  });
const result = await run({
  collection: "items",
  filter: { n: { $gte: 1 } },
  sort: { n: 1 },
  projection: { _id: 0, n: 1, name: 1 },
  limit: 2,
});
assert.equal(result.rows.length, 2);
assert.equal(result.truncated, true);
assert.equal(result.format, "extended-json");
assert.deepEqual(
  result.rows.map((row) => row.n),
  [{ $numberInt: "1" }, { $numberInt: "2" }],
);
assert.equal(result.rows[1].name, "two");
const selected = await run({
  collection: "items",
  filter: { n: { $numberInt: "2" } },
  projection: { _id: 0, name: 1 },
});
assert.deepEqual(selected.rows, [{ name: "two" }]);
await assert.rejects(
  run({ collection: "items", filter: { $where: "db.items.deleteMany({})" } }),
  /禁止/,
);
assert.equal((await run({ collection: "items" })).rows.length, 3);
console.log("REAL_MONGODB_FIXTURES_PASS");

// This script is run only against the existing CI-owned MongoDB service.
// Seed writes belong to this fixture; application queries remain read-only.
const { MongoClient, Long, Int32 } = await import("mongodb");
const { createServer } = await import("node:http");
const { mkdtemp, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { randomUUID } = await import("node:crypto");
const { createApp } = await import("../src/server.mjs");
const collection = "integer_precision_" + randomUUID().replaceAll("-", "");
const intended = "9007199254740993";
const rounded = "9007199254740992";
const connection = {
  type: "mongodb",
  host: "127.0.0.1",
  port: 27017,
  database: "fixture",
};
const seed = new MongoClient("mongodb://127.0.0.1:27017", {
  directConnection: true,
  promoteLongs: false,
  serverSelectionTimeoutMS: 3000,
});
const root = await mkdtemp(join(tmpdir(), "mongo-precision-"));
let app;
let hits = 0;
const echo = createServer((req, res) => {
  hits++;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ exact: req.headers["x-exact"] }));
});
const closeServer = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
};
try {
  await seed.connect();
  const fixture = seed.db("fixture").collection(collection);
  const intFixture = seed.db("fixture").collection(collection + "_int");
  const intBoundaries = [
    ["-2147483648", "int-minimum"],
    ["2147483647", "int-maximum"],
    ["0", "int-zero"],
  ];
  await intFixture.insertMany(
    intBoundaries.map(([value, label]) => ({
      id: new Int32(Number(value)),
      label,
    })),
  );
  const intSnapshot = await intFixture
    .find({}, { projection: { _id: 0 } })
    .sort({ id: 1 })
    .toArray();
  for (const [value, label] of intBoundaries) {
    const boundaryQuery = {
      collection: collection + "_int",
      filter: { id: { $numberInt: value } },
      projection: { _id: 0, label: 1 },
    };
    for (const input of [
      { query: boundaryQuery },
      { sql: JSON.stringify(boundaryQuery) },
    ]) {
      assert.deepEqual(
        (await queryRemoteDatabase({ ...connection, ...input })).rows,
        [{ label }],
      );
    }
  }
  const longMin = "-9223372036854775808";
  const longMax = "9223372036854775807";
  await fixture.insertMany([
    { id: Long.fromString(longMin), label: "minimum" },
    { id: Long.fromString(longMax), label: "maximum" },
    { id: Long.fromString("0"), label: "zero" },
    { id: Long.fromString(rounded), label: "neighbor" },
    { id: Long.fromString(intended), label: "intended" },
  ]);
  const query = {
    collection,
    filter: { id: { $numberLong: intended } },
    projection: { _id: 0, id: 1, label: 1 },
  };
  const exact = await run(query);
  assert.deepEqual(exact.rows, [
    { id: { $numberLong: intended }, label: "intended" },
  ]);
  assert.deepEqual(
    (await run({ ...query, filter: { id: { $numberLong: rounded } } })).rows,
    [{ id: { $numberLong: rounded }, label: "neighbor" }],
  );
  for (const [value, label] of [
    [longMin, "minimum"],
    [longMax, "maximum"],
    ["0", "zero"],
  ]) {
    // Assert matching semantics, not small-Long output promotion by the driver.
    const boundaryQuery = {
      ...query,
      filter: { id: { $numberLong: value } },
      projection: { _id: 0, label: 1 },
    };
    for (const input of [
      { query: boundaryQuery },
      { sql: JSON.stringify(boundaryQuery) },
    ]) {
      assert.deepEqual(
        (await queryRemoteDatabase({ ...connection, ...input })).rows,
        [{ label }],
      );
    }
  }
  const invalidLongFilters = [
    { id: { $numberLong: "9223372036854775808" } },
    { id: { $numberLong: "18446744073709551616" } },
    { id: { $numberLong: "-9223372036854775809" } },
    { id: { $numberLong: intended, extra: "discarded" } },
    { id: { $numberLong: intended, $gt: 0 } },
  ];
  const invalidNumericCases = [
    ...invalidLongFilters.map((filter) => ({
      query: { ...query, filter },
      error: /\$numberLong/,
    })),
    ...["2147483648", "-2147483649", "4294967296"].map((value) => ({
      query: {
        ...query,
        collection: collection + "_int",
        filter: { id: { $numberInt: value } },
      },
      error: /\$numberInt/,
    })),
    ...["$numberInt", "$numberLong", "$numberDouble", "$numberDecimal"].flatMap(
      (wrapper) =>
        [{ extra: "discarded" }, { $gt: 0 }].map((extra) => ({
          query: { ...query, filter: { id: { [wrapper]: "0", ...extra } } },
          error: new RegExp("\\" + wrapper),
        })),
    ),
  ];
  for (const { query: invalidQuery, error } of invalidNumericCases) {
    for (const input of [
      { query: invalidQuery },
      { sql: JSON.stringify(invalidQuery) },
    ]) {
      await assert.rejects(
        queryRemoteDatabase({ ...connection, ...input }),
        error,
      );
    }
  }
  const unsafeSQL = `{"collection":"${collection}","filter":{"id":9007199254740993}}`;
  const unsafe = JSON.parse(unsafeSQL);
  for (const input of [{ query: unsafe }, { sql: unsafeSQL }]) {
    await assert.rejects(
      queryRemoteDatabase({ ...connection, ...input }),
      /安全精度/,
    );
  }
  const snapshot = await fixture
    .find({}, { projection: { _id: 0 } })
    .sort({ id: 1 })
    .toArray();
  assert.deepEqual(
    snapshot.map((row) => row.id.toString()),
    [longMin, "0", rounded, intended, longMax],
  );
  console.log("REAL_MONGODB_INTEGER_FILTER_PRECISION_PASS");

  await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
  app = await createApp({ root, port: 0 });
  const api = async (
    path,
    body,
    method = body === undefined ? "GET" : "POST",
    status = 200,
  ) => {
    const response = await fetch(app.url + path, {
      method,
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  };
  const project = await api(
    "/api/projects",
    { name: "Mongo integer precision" },
    "POST",
    201,
  );
  const base = (id, action) => `/api/projects/${id}/${action}`;
  const grant = await api(base(project.id, "database-connections"), {
    ...connection,
    name: "CI Mongo read",
  });
  const requestFor = (connectionId, sql) => ({
    method: "GET",
    url: `http://127.0.0.1:${echo.address().port}/echo`,
    headers: [{ key: "X-Exact", value: "{{exact}}", enabled: true }],
    before: [
      {
        type: "database",
        connectionId,
        sql,
        parameters: [],
        name: "exact",
        path: "$.rows[0].id.$numberLong",
      },
    ],
  });
  const plan = await api(base(project.id, "plans"), {
    name: "Exact Long → variable → HTTP",
    steps: [{ request: requestFor(grant.id, JSON.stringify(query)) }],
  });
  const passed = await api(base(project.id, "run"), { planId: plan.id });
  assert.equal(passed.status, "passed", JSON.stringify(passed.results));
  assert.equal(passed.variables.exact, intended);
  assert.deepEqual(JSON.parse(passed.results[0].response.body), {
    exact: intended,
  });
  assert.equal(hits, 1);
  assert.equal(passed.recordSaved, true);
  const { recordSaved: savedPass, ...passedEvidence } = passed;
  assert.deepEqual((await app.store.get(project.id)).runs[0], {
    ...passedEvidence,
    source: "manual",
  });

  const beforeState = await app.store.get(project.id);
  const invalidRequest = requestFor(grant.id, unsafeSQL);
  invalidRequest.before.unshift({
    type: "set",
    name: "unpublished",
    value: "must-not-escape",
  });
  const invalidPlan = await api(base(project.id, "plans"), {
    steps: [{ request: invalidRequest }],
  });
  const failed = await api(base(project.id, "run"), { planId: invalidPlan.id });
  assert.equal(failed.status, "failed");
  assert.match(failed.results[0].error, /安全精度/);
  assert.deepEqual(failed.variables, failed.initialVariables);
  assert.equal(failed.variables.unpublished, undefined);
  assert.equal(failed.variables.exact, undefined);
  assert.equal(failed.results[0].response, undefined);
  assert.equal(hits, 1, "invalid filter must not dispatch HTTP");
  const afterState = await app.store.get(project.id);
  assert.deepEqual(afterState.globalVariables, beforeState.globalVariables);
  assert.deepEqual(afterState.environments, beforeState.environments);
  assert.equal(failed.recordSaved, true);
  const { recordSaved: savedFailure, ...failedEvidence } = failed;
  assert.deepEqual(afterState.runs[0], {
    ...failedEvidence,
    source: "manual",
  });
  assert.deepEqual(
    await fixture
      .find({}, { projection: { _id: 0 } })
      .sort({ id: 1 })
      .toArray(),
    snapshot,
  );
  console.log("REAL_MONGODB_INTEGER_FILTER_ATOMIC_FAILURE_PASS");

  // Every invalid wrapper must fail atomically even after an earlier local operation.
  for (const { query: invalidQuery, error } of invalidNumericCases) {
    const invalidWrapperRequest = requestFor(
      grant.id,
      JSON.stringify(invalidQuery),
    );
    invalidWrapperRequest.before.unshift({
      type: "set",
      name: "unpublished",
      value: "must-not-escape",
    });
    const wrapperPlan = await api(base(project.id, "plans"), {
      steps: [{ request: invalidWrapperRequest }],
    });
    const wrapperFailure = await api(base(project.id, "run"), {
      planId: wrapperPlan.id,
    });
    assert.equal(wrapperFailure.status, "failed");
    assert.match(wrapperFailure.results[0].error, error);
    assert.deepEqual(wrapperFailure.variables, wrapperFailure.initialVariables);
    assert.equal(wrapperFailure.variables.unpublished, undefined);
    assert.equal(wrapperFailure.variables.exact, undefined);
    assert.equal(wrapperFailure.results[0].response, undefined);
    assert.equal(hits, 1, "invalid numeric wrapper must not dispatch HTTP");
    assert.equal(wrapperFailure.recordSaved, true);
    const { recordSaved, ...evidence } = wrapperFailure;
    const persisted = await app.store.get(project.id);
    assert.deepEqual(persisted.runs[0], { ...evidence, source: "manual" });
    assert.deepEqual(persisted.globalVariables, beforeState.globalVariables);
    assert.deepEqual(persisted.environments, beforeState.environments);
    assert.deepEqual(
      await fixture
        .find({}, { projection: { _id: 0 } })
        .sort({ id: 1 })
        .toArray(),
      snapshot,
    );
  }
  assert.deepEqual(
    await intFixture
      .find({}, { projection: { _id: 0 } })
      .sort({ id: 1 })
      .toArray(),
    intSnapshot,
  );
  console.log("REAL_MONGODB_EJSON_LONG_BOUNDS_ATOMIC_FAILURE_PASS");
  console.log("REAL_MONGODB_EJSON_NUMERIC_WRAPPERS_ATOMIC_FAILURE_PASS");

  const backup = await api(base(project.id, "export"));
  const restored = await api("/api/restore", { document: backup }, "POST", 201);
  assert.deepEqual(restored.runs, backup.runs);
  assert.deepEqual(await api(base(restored.id, "database-connections")), []);
  const restoredPlan = restored.plans.find((item) => item.id === plan.id);
  assert(restoredPlan, "frozen exact plan survives backup/restore");
  const foreign = await api(base(restored.id, "run"), {
    planId: restoredPlan.id,
  });
  assert.equal(foreign.status, "failed");
  assert.match(foreign.results[0].error, /未授权|失效/);
  assert.equal(hits, 1);
  await closeServer(app.server);
  app = await createApp({ root, port: 0 });
  assert.deepEqual(await api(base(project.id, "database-connections")), []);
  assert.deepEqual(await api(base(restored.id, "database-connections")), []);
  assert.deepEqual((await app.store.get(project.id)).runs, backup.runs);
  const expired = await api(base(project.id, "run"), { planId: plan.id });
  assert.equal(expired.status, "failed");
  assert.match(expired.results[0].error, /未授权|失效/);
  assert.equal(hits, 1);
  const regrant = await api(base(restored.id, "database-connections"), {
    ...connection,
    name: "CI regrant",
  });
  const renewed = await api(base(restored.id, "plans"), {
    id: restoredPlan.id,
    steps: [{ request: requestFor(regrant.id, JSON.stringify(query)) }],
  });
  const recovered = await api(base(restored.id, "run"), { planId: renewed.id });
  assert.equal(recovered.status, "passed", JSON.stringify(recovered.results));
  assert.equal(recovered.variables.exact, intended);
  assert.deepEqual(JSON.parse(recovered.results[0].response.body), {
    exact: intended,
  });
  assert.equal(hits, 2);
  assert.equal(recovered.recordSaved, true);
  const { recordSaved: savedRecovery, ...recoveredEvidence } = recovered;
  assert.deepEqual((await app.store.get(restored.id)).runs[0], {
    ...recoveredEvidence,
    source: "manual",
  });
  assert.deepEqual(await api(base(project.id, "database-connections")), []);
  assert.deepEqual(
    await fixture
      .find({}, { projection: { _id: 0 } })
      .sort({ id: 1 })
      .toArray(),
    snapshot,
  );
  console.log("REAL_MONGODB_INTEGER_FILTER_RESTORE_REGRANT_PASS");
} finally {
  if (app?.server.listening) await closeServer(app.server);
  if (echo.listening) await closeServer(echo);
  for (const name of [collection, collection + "_int"]) {
    await seed
      .db("fixture")
      .collection(name)
      .drop()
      .catch((error) => {
        if (error.codeName !== "NamespaceNotFound") throw error;
      });
  }
  await seed.close();
  await rm(root, { recursive: true, force: true });
}
