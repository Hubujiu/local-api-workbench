import test from "node:test";
import assert from "node:assert/strict";
import {
  projectHistoryProjection,
  sameHistoryJSON,
  validateRequestDefinitionHistory,
  reconcileRequestDefinitionHistory,
  listRequestDefinitionHistory,
  getRequestDefinitionVersion,
  applyRequestDefinitionHistoryOperation,
  REQUEST_DEFINITION_HISTORY_MAX_BYTES,
  REQUEST_DEFINITION_SNAPSHOT_MAX_BYTES,
} from "../src/request-definition-history.mjs";

const now = "2026-11-04T07:00:00.000Z";
let sequence = 0;
const makeId = () => "generated-" + ++sequence;
const clone = (value) => structuredClone(value);
const fixture = () => ({
  id: "project-a",
  name: "Model fixture",
  requests: [
    {
      id: "a",
      name: "A",
      method: "POST",
      url: "https://example.invalid/a",
      body: "first",
      auth: { type: "bearer", token: "static-fixture" },
    },
    {
      id: "b",
      name: "B",
      method: "GET",
      url: "https://example.invalid/b",
      body: "peer",
    },
  ],
  history: [{ id: "execution", outcome: "retained" }],
  runs: [{ id: "run", frozen: { data: "retained" } }],
});
function save(previous, next, options = {}) {
  const result = clone(next);
  result.requestDefinitionHistory = reconcileRequestDefinitionHistory(
    previous,
    next,
    { now, makeId, ...options },
  );
  return result;
}
const initial = () => save(undefined, fixture());
const entry = (project, requestId = "a") =>
  project.requestDefinitionHistory.entries.find(
    (item) => item.requestId === requestId && !item.retired,
  );
function edited(project, value = "second", requestId = "a", options) {
  const next = clone(project);
  next.requests.find((item) => item.id === requestId).body = value;
  return save(project, next, options);
}
function operation(project, kind, extra = {}, requestId = "a") {
  return applyRequestDefinitionHistoryOperation(
    project,
    {
      kind,
      requestId,
      lineageId: entry(project, requestId).lineageId,
      ...extra,
    },
    { now },
  );
}
function unchangedFailure(project, run, pattern) {
  const before = clone(project);
  assert.throws(run, pattern);
  assert.deepEqual(project, before);
}

test("new requests have current metadata but no fake old definition, with deep isolation", () => {
  const project = fixture();
  const saved = save(undefined, project);
  assert.equal(entry(saved).versions.length, 0);
  assert.equal(entry(saved).currentVersion, 1);
  assert.notEqual(entry(saved).lineageId, entry(saved, "b").lineageId);
  assert.equal(project.requestDefinitionHistory, undefined);
  const changed = edited(saved);
  assert.equal(entry(changed).versions[0].definition.body, "first");
  assert.deepEqual(
    entry(changed).versions[0].definition.auth,
    project.requests[0].auth,
  );
  changed.requests[0].auth.token = "different";
  assert.equal(
    entry(changed).versions[0].definition.auth.token,
    "static-fixture",
  );
  assert.equal(saved.requests[0].auth.token, "static-fixture");
});

test("legacy reads are deterministic, untracked and never synthesize IDs or timestamps", () => {
  const project = fixture();
  const before = clone(project);
  const listed = listRequestDefinitionHistory(project, { requestId: "a" });
  assert.equal(listed.tracked, false);
  assert.equal(listed.lineageId, null);
  assert.equal(listed.current.version, null);
  assert.equal(listed.current.createdAt, null);
  assert.deepEqual(listed.versions, []);
  const current = getRequestDefinitionVersion(project, {
    requestId: "a",
    historyId: "current",
  });
  assert.deepEqual(current.definition, project.requests[0]);
  assert.equal(current.lineageId, null);
  assert.deepEqual(project, before);
  validateRequestDefinitionHistory(project);
});

test("first legacy edit captures previous definition; no-op initialization does not", () => {
  const previous = fixture();
  const next = clone(previous);
  next.requests[0].body = "edited";
  const changed = save(previous, next);
  assert.equal(entry(changed).currentVersion, 2);
  assert.equal(entry(changed).versions[0].definition.body, "first");
  const unchanged = save(previous, previous);
  assert.equal(entry(unchanged).currentVersion, 1);
  assert.equal(entry(unchanged).versions.length, 0);
});

test("material definition equality follows persisted JSON, including unknown future fields", () => {
  let project = initial();
  let next = clone(project);
  next.requests[0].future = undefined;
  next.requests[0].auth = { token: "static-fixture", type: "bearer" };
  next = save(project, next);
  assert.equal(entry(next).currentVersion, 1);
  project = next;
  next = clone(project);
  next.requests[0].futurePRField = {
    source: "future",
    bodyMedia: { explicit: true },
  };
  next = save(project, next);
  assert.equal(entry(next).currentVersion, 2);
  project = next;
  next = edited(project, "third");
  assert.deepEqual(entry(next).versions.at(-1).definition.futurePRField, {
    source: "future",
    bodyMedia: { explicit: true },
  });
});

test("100 old versions plus current are isolated per target and ordered by sequence, not time", () => {
  let project = initial();
  for (let index = 0; index < 105; index++) {
    project = edited(project, "a-" + index, "a", {
      now: index % 2 ? now : "2020-01-01T00:00:00.000Z",
    });
    project = edited(project, "b-" + index, "b", {
      now: "2010-01-01T00:00:00.000Z",
    });
  }
  for (const requestId of ["a", "b"]) {
    const tracker = entry(project, requestId);
    assert.equal(tracker.versions.length, 100);
    assert.equal(tracker.currentVersion, 106);
    assert.equal(tracker.versions[0].version, 6);
    assert.equal(tracker.versions.at(-1).version, 105);
    const listed = listRequestDefinitionHistory(project, {
      requestId,
      limit: 100,
    });
    assert.equal(listed.current.version, 106);
    assert.equal(listed.total, 100);
    assert.deepEqual(
      listed.versions.map((version) => version.version),
      Array.from({ length: 100 }, (_, i) => 105 - i),
    );
    assert.ok(
      listed.versions.every((version) => !Object.hasOwn(version, "definition")),
    );
  }
});

test("tag current and old version without taking snapshots; ordinary save preserves authorized metadata", () => {
  const original = initial();
  const tagged = operation(original, "tag", {
    historyId: "current",
    tag: "release A",
  });
  let project = save(original, tagged);
  assert.equal(entry(project).currentVersion, 1);
  assert.equal(entry(project).currentTag, "release A");
  assert.equal(entry(project).versions.length, 0);
  project = edited(project);
  assert.equal(entry(project).versions[0].tag, "release A");
  assert.equal(entry(project).currentTag, "");
  const oldId = entry(project).versions[0].id;
  const relabeled = operation(project, "tag", {
    historyId: oldId,
    tag: "old release",
  });
  const saved = save(project, relabeled);
  assert.equal(entry(saved).versions[0].tag, "old release");
  assert.equal(entry(saved).currentVersion, 2);
  assert.equal(entry(project).versions[0].tag, "release A");
});

test("restore A→B→A→B goes through ordinary reconcile, retaining current and peer evidence", () => {
  let project = edited(initial());
  const oldId = entry(project).versions[0].id;
  const before = clone(project);
  const draft = operation(project, "restore", { historyId: oldId });
  assert.deepEqual(project, before);
  assert.equal(draft.requests[0].body, "first");
  assert.deepEqual(
    draft.requestDefinitionHistory,
    project.requestDefinitionHistory,
  );
  project = save(project, draft);
  assert.equal(entry(project).currentVersion, 3);
  assert.equal(entry(project).versions.at(-1).definition.body, "second");
  const bId = entry(project).versions.at(-1).id;
  project = save(project, operation(project, "restore", { historyId: bId }));
  assert.equal(entry(project).currentVersion, 4);
  assert.equal(project.requests[0].body, "second");
  assert.deepEqual(project.requests[1], before.requests[1]);
  assert.deepEqual(project.history, before.history);
  assert.deepEqual(project.runs, before.runs);
});

test("read and mutation cannot use another target, project or lineage as the selected source", () => {
  let project = edited(initial());
  project = edited(project, "peer-edit", "b");
  const a = entry(project),
    b = entry(project, "b");
  assert.throws(
    () =>
      getRequestDefinitionVersion(project, {
        requestId: "b",
        historyId: a.versions[0].id,
      }),
    /不存在/,
  );
  assert.throws(
    () =>
      getRequestDefinitionVersion(project, {
        requestId: "b",
        lineageId: a.lineageId,
        historyId: "current",
      }),
    /不存在/,
  );
  for (const kind of ["tag", "restore"]) {
    unchangedFailure(
      project,
      () =>
        operation(project, kind, {
          historyId: b.versions[0].id,
          ...(kind === "tag" ? { tag: "x" } : {}),
        }),
      /不存在/,
    );
  }
  const alien = clone(project);
  alien.id = "project-other";
  assert.throws(() => validateRequestDefinitionHistory(alien), /归属/);
  const mismatched = clone(project);
  entry(mismatched).versions[0].definition.id = "b";
  assert.throws(() => validateRequestDefinitionHistory(mismatched), /归属/);
});

test("clear preserves active lineage and sequence high-water; selected IDs are all-or-nothing", () => {
  const project = edited(edited(initial()), "third");
  const tracker = entry(project);
  unchangedFailure(
    project,
    () =>
      operation(project, "clear", {
        historyIds: [tracker.versions[0].id, "missing"],
      }),
    /不属于/,
  );
  const cleared = save(project, operation(project, "clear", { all: true }));
  assert.equal(entry(cleared).currentVersion, 3);
  assert.equal(entry(cleared).lineageId, tracker.lineageId);
  assert.equal(entry(cleared).versions.length, 0);
  const fourth = edited(cleared, "fourth");
  assert.equal(entry(fourth).currentVersion, 4);
  assert.equal(entry(fourth).versions[0].version, 3);
  const partial = operation(project, "clear", {
    historyIds: [tracker.versions[0].id],
  });
  assert.deepEqual(
    entry(partial).versions.map((v) => v.id),
    [tracker.versions[1].id],
  );
  assert.deepEqual(entry(partial, "b"), entry(project, "b"));
});

test("soft deletion changes only lifecycle; simultaneous body edit archives, legal revival keeps lineage", () => {
  let project = initial();
  const lineageId = entry(project).lineageId;
  let next = clone(project);
  next.requests[0].deletedAt = now;
  project = save(project, next);
  assert.equal(entry(project).currentVersion, 1);
  project = edited(project);
  assert.equal(entry(project).currentVersion, 2);
  assert.equal(entry(project).versions[0].definition.deletedAt, now);
  unchangedFailure(
    project,
    () =>
      operation(project, "restore", {
        historyId: entry(project).versions[0].id,
      }),
    /活动/,
  );
  next = clone(project);
  delete next.requests[0].deletedAt;
  project = save(project, next);
  assert.equal(entry(project).lineageId, lineageId);
  assert.equal(entry(project).currentVersion, 2);
  next = operation(project, "restore", {
    historyId: entry(project).versions[0].id,
  });
  assert.equal(next.requests[0].deletedAt, undefined);
});

test("hard remove retires and captures current; repeated ID reuse gets new lineages", () => {
  let project = edited(initial());
  const firstLineage = entry(project).lineageId;
  let next = clone(project);
  next.requests = next.requests.filter((request) => request.id !== "a");
  project = save(project, next);
  const retired = project.requestDefinitionHistory.entries.find(
    (item) => item.lineageId === firstLineage,
  );
  assert.equal(retired.retired, true);
  assert.equal(retired.versions.at(-1).definition.body, "second");
  assert.equal(retired.versions.at(-1).version, 2);
  assert.equal(
    listRequestDefinitionHistory(project, { requestId: "a" }).current,
    null,
  );
  assert.throws(
    () =>
      getRequestDefinitionVersion(project, {
        requestId: "a",
        lineageId: firstLineage,
        historyId: "current",
      }),
    /当前/,
  );
  next = clone(project);
  next.requests.push({ ...fixture().requests[0], body: "replacement" });
  project = save(project, next);
  const secondLineage = entry(project).lineageId;
  assert.notEqual(secondLineage, firstLineage);
  assert.equal(entry(project).currentVersion, 1);
  assert.equal(
    listRequestDefinitionHistory(project, { requestId: "a" }).lineageId,
    secondLineage,
  );
  unchangedFailure(
    project,
    () =>
      applyRequestDefinitionHistoryOperation(project, {
        kind: "restore",
        requestId: "a",
        lineageId: firstLineage,
        historyId: retired.versions[0].id,
      }),
    /活动/,
  );
  next = clone(project);
  next.requests = next.requests.filter((request) => request.id !== "a");
  project = save(project, next);
  assert.throws(
    () => listRequestDefinitionHistory(project, { requestId: "a" }),
    /指定/,
  );
  const cleared = applyRequestDefinitionHistoryOperation(project, {
    kind: "clear",
    requestId: "a",
    lineageId: firstLineage,
    all: true,
  });
  assert.equal(
    cleared.requestDefinitionHistory.entries.some(
      (item) => item.lineageId === firstLineage,
    ),
    false,
  );
  assert.equal(
    cleared.requestDefinitionHistory.entries.some(
      (item) => item.lineageId === secondLineage,
    ),
    true,
  );
});

test("archived projects and current versions cannot be definition-restored", () => {
  const project = edited(initial());
  assert.throws(
    () => operation(project, "restore", { historyId: "current" }),
    /当前/,
  );
  project.archived = true;
  unchangedFailure(
    project,
    () =>
      operation(project, "restore", {
        historyId: entry(project).versions[0].id,
      }),
    /活动/,
  );
});

test("valid imported history is preserved and owner mismatch fails before retention", () => {
  const project = edited(initial());
  const imported = save(undefined, project, {
    makeId: () => {
      throw Error("must not allocate");
    },
  });
  assert.deepEqual(imported, project);
  const alien = clone(project);
  alien.requestDefinitionHistory.projectId = "wrong-project";
  assert.throws(() => save(undefined, alien), /归属/);
  const reidentified = clone(project);
  reidentified.id = "backup-copy";
  reidentified.requestDefinitionHistory.projectId = "backup-copy";
  const restored = save(undefined, reidentified);
  assert.equal(restored.requestDefinitionHistory.projectId, "backup-copy");
  assert.deepEqual(
    restored.requestDefinitionHistory.entries,
    project.requestDefinitionHistory.entries,
  );
});

test("entire incoming collection is validated, not cropped before detecting corrupt or duplicate entries", () => {
  const project = edited(initial());
  for (const corrupt of [
    (p) => {
      entry(p).versions[0].version = 0;
    },
    (p) => {
      entry(p).versions[0].definition.id = "b";
    },
    (p) => {
      entry(p, "b").versions = [clone(entry(p).versions[0])];
      entry(p, "b").currentVersion = 2;
    },
    (p) => {
      entry(p, "b").lineageId = entry(p).lineageId;
    },
    (p) => {
      p.requestDefinitionHistory.entries.push(clone(entry(p)));
      p.requestDefinitionHistory.entries.at(-1).lineageId = "extra-active";
    },
    (p) => {
      entry(p).currentVersion = 1;
    },
    (p) => {
      entry(p).versions = Array.from({ length: 101 }, (_, i) => ({
        ...clone(entry(p).versions[0]),
        id: "overflow-" + i,
        version: i + 1,
      }));
      entry(p).currentVersion = 102;
    },
  ]) {
    const invalid = clone(project);
    corrupt(invalid);
    unchangedFailure(invalid, () => save(undefined, invalid));
  }
});

test("pagination, operation shapes, tags, required lineage and current sentinel are strict", () => {
  const project = edited(initial());
  for (const query of [
    { offset: -1 },
    { offset: 0.5 },
    { offset: 10001 },
    { limit: 0 },
    { limit: 101 },
    { limit: "20" },
    { extra: true },
  ])
    assert.throws(() =>
      listRequestDefinitionHistory(project, { requestId: "a", ...query }),
    );
  for (const extra of [
    { all: false },
    { all: true, historyIds: [] },
    { historyIds: [] },
    { historyIds: ["current"] },
    {
      historyIds: [
        entry(project).versions[0].id,
        entry(project).versions[0].id,
      ],
    },
  ])
    assert.throws(() => operation(project, "clear", extra));
  for (const value of ["x".repeat(201), null, 2, "bad\0tag", "\ud800"])
    assert.throws(() =>
      operation(project, "tag", { historyId: "current", tag: value }),
    );
  assert.throws(() =>
    applyRequestDefinitionHistoryOperation(project, {
      kind: "clear",
      requestId: "a",
      all: true,
    }),
  );
  assert.throws(() =>
    operation(project, "tag", {
      historyId: "current",
      tag: "x",
      definition: {},
    }),
  );
});

test("activity saves never initialize or alter history and reject definitions or metadata deltas", () => {
  const legacy = fixture();
  assert.equal(
    reconcileRequestDefinitionHistory(legacy, legacy, {
      activity: true,
      makeId: () => {
        throw Error("no IDs");
      },
    }),
    undefined,
  );
  const project = edited(initial());
  const next = clone(project);
  next.history.push({ id: "new-execution" });
  assert.equal(
    reconcileRequestDefinitionHistory(project, next, { activity: true }),
    project.requestDefinitionHistory,
  );
  next.requests[0].body = "unsafe";
  assert.throws(
    () => reconcileRequestDefinitionHistory(project, next, { activity: true }),
    /运行活动/,
  );
  assert.throws(
    () =>
      reconcileRequestDefinitionHistory(
        project,
        operation(project, "tag", { historyId: "current", tag: "unsafe" }),
        { activity: true },
      ),
    /运行活动/,
  );
  const deleted = clone(project);
  deleted.requests[0].deletedAt = now;
  assert.throws(
    () =>
      reconcileRequestDefinitionHistory(project, deleted, { activity: true }),
    /运行活动/,
  );
});

test("descriptor-safe projection rejects executable objects without invoking user code", () => {
  let invocations = 0;
  const getter = {};
  Object.defineProperty(getter, "value", {
    enumerable: true,
    get() {
      invocations++;
      throw Error("executed");
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        invocations++;
        throw Error("executed");
      },
      getPrototypeOf() {
        invocations++;
        throw Error("executed");
      },
    },
  );
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const cycle = {};
  cycle.self = cycle;
  const sparse = [];
  sparse.length = 2;
  sparse[1] = 1;
  const extra = [1];
  extra.added = 2;
  const hiddenArray = [1];
  Object.defineProperty(hiddenArray, "extra", { value: 2 });
  const hidden = {};
  Object.defineProperty(hidden, "value", { value: 1 });
  const symbol = { [Symbol("key")]: 1 };
  const invalid = [
    getter,
    proxy,
    revoked.proxy,
    cycle,
    sparse,
    extra,
    hiddenArray,
    hidden,
    symbol,
    new Date(),
    new Map(),
    {
      toJSON() {
        invocations++;
        return {};
      },
    },
    { value: Infinity },
    { value: NaN },
    { value: 1n },
    [undefined],
    { value: () => 1 },
    { value: Symbol("x") },
  ];
  for (const value of invalid)
    assert.throws(() => projectHistoryProjection(value));
  assert.equal(invocations, 0);
});

test("literal constructor and __proto__ data keys survive projection, history and restore safely", () => {
  const data = JSON.parse(
    '{"constructor":{"prototype":{"safe":true}},"__proto__":{"polluted":true},"prototype":"schema"}',
  );
  const projected = projectHistoryProjection(data);
  assert.deepEqual(projected, data);
  assert.equal(Object.getPrototypeOf(projected), Object.prototype);
  assert.equal({}.polluted, undefined);
  let project = fixture();
  project.requests[0].schema = data;
  project = save(undefined, project);
  project = edited(project);
  const restored = operation(project, "restore", {
    historyId: entry(project).versions[0].id,
  });
  assert.deepEqual(restored.requests[0].schema, data);
  assert.equal({}.polluted, undefined);
});

test("undefined object fields and negative zero compare exactly as persisted JSON", () => {
  assert.equal(
    sameHistoryJSON(
      { a: undefined, b: { n: -0 }, c: [1, null] },
      { c: [1, null], b: { n: 0 } },
    ),
    true,
  );
  assert.equal(sameHistoryJSON(undefined, undefined), true);
  assert.equal(sameHistoryJSON(undefined, null), false);
  const source = Object.create(null);
  source.constructor = { value: "safe", omitted: undefined };
  assert.deepEqual(projectHistoryProjection(source), {
    constructor: { value: "safe" },
  });
});

test("projection enforces depth, node and byte budgets, including exponential shared data", () => {
  let deep = {};
  for (let i = 0; i < 70; i++) deep = { child: deep };
  assert.throws(() => projectHistoryProjection(deep), /结构/);
  assert.throws(
    () => projectHistoryProjection({ a: 1, b: 2 }, { maxNodes: 2 }),
    /结构/,
  );
  assert.throws(
    () => projectHistoryProjection("é".repeat(100), { maxBytes: 100 }),
    /体积/,
  );
  assert.throws(() => projectHistoryProjection({}, { maxBytes: NaN }), /预算/);
  let shared = "leaf";
  for (let i = 0; i < 25; i++) shared = [shared, shared];
  assert.throws(() => projectHistoryProjection(shared), /结构|体积/);
  assert.equal(
    Buffer.byteLength(
      JSON.stringify(projectHistoryProjection({ a: "é" }, { maxBytes: 10 })),
    ),
    10,
  );
});

test("snapshot, history and tracker budgets fail closed without evicting unrelated retained definitions", () => {
  const oversized = initial();
  oversized.requests[0].body = "x".repeat(
    REQUEST_DEFINITION_SNAPSHOT_MAX_BYTES,
  );
  unchangedFailure(oversized, () => edited(oversized, "new"), /体积/);
  const total = edited(initial());
  const template = entry(total).versions[0];
  entry(total).versions = Array.from({ length: 9 }, (_, i) => ({
    ...clone(template),
    id: "large-" + i,
    version: i + 1,
    definition: { id: "a", body: "x".repeat(950000) },
  }));
  entry(total).currentVersion = 10;
  assert.ok(
    Buffer.byteLength(JSON.stringify(total.requestDefinitionHistory)) >
      REQUEST_DEFINITION_HISTORY_MAX_BYTES,
  );
  unchangedFailure(
    total,
    () => validateRequestDefinitionHistory(total),
    /体积/,
  );
  const trackers = initial();
  trackers.requestDefinitionHistory.entries = Array.from(
    { length: 10001 },
    (_, i) => ({
      requestId: "retired-" + i,
      lineageId: "lineage-" + i,
      currentVersion: 1,
      currentCreatedAt: now,
      currentTag: "",
      retired: true,
      versions: [],
    }),
  );
  assert.throws(() => validateRequestDefinitionHistory(trackers), /容量/);
});

test("invalid or colliding generated IDs, exhausted sequence and missing active targets are rejected", () => {
  assert.throws(
    () => save(undefined, fixture(), { makeId: () => "same" }),
    /重复/,
  );
  assert.throws(
    () => save(undefined, fixture(), { makeId: () => "current" }),
    /保留/,
  );
  const project = initial();
  entry(project).currentVersion = Number.MAX_SAFE_INTEGER;
  assert.throws(() => edited(project), /耗尽/);
  const missing = initial();
  missing.requests.shift();
  assert.throws(() => validateRequestDefinitionHistory(missing), /接口不存在/);
  const wrongProject = clone(project);
  wrongProject.id = "another";
  delete wrongProject.requestDefinitionHistory;
  assert.throws(() => save(project, wrongProject), /归属/);
});

test("legacy absence does not impose history budgets on unrelated project data", () => {
  const project = fixture();
  project.unrelated = "x".repeat(13 * 1024 * 1024);
  assert.doesNotThrow(() => validateRequestDefinitionHistory(project));
  let reads = 0;
  Object.defineProperty(project, "unrelatedGetter", {
    enumerable: true,
    get() {
      reads++;
      throw Error("not history");
    },
  });
  assert.doesNotThrow(() => validateRequestDefinitionHistory(project));
  assert.equal(reads, 0);
  Object.defineProperty(project, "requestDefinitionHistory", {
    enumerable: true,
    get() {
      reads++;
      return undefined;
    },
  });
  assert.throws(() => validateRequestDefinitionHistory(project), /访问器/);
  assert.equal(reads, 0);
});

test("request IDs retain existing Unicode and slash identity contract", () => {
  const project = fixture();
  project.requests[0].id = "接口/详情 甲";
  const saved = save(undefined, project);
  const next = clone(saved);
  next.requests[0].body = "changed";
  const changed = save(saved, next);
  const id = changed.requests[0].id;
  const tracker = entry(changed, id);
  assert.equal(tracker.versions[0].definition.id, id);
  assert.equal(
    listRequestDefinitionHistory(changed, { requestId: id }).total,
    1,
  );
  assert.equal(
    getRequestDefinitionVersion(changed, {
      requestId: id,
      historyId: tracker.versions[0].id,
    }).definition.id,
    id,
  );
});

test("new snapshots exclude lifecycle deletedAt while preserving all definition fields", () => {
  const project = initial();
  project.requests[0].deletedAt = now;
  const changed = edited(project);
  assert.equal(
    Object.hasOwn(entry(changed).versions[0].definition, "deletedAt"),
    false,
  );
  assert.equal(
    entry(changed).versions[0].definition.auth.token,
    "static-fixture",
  );
});
