import test from "node:test";
import assert from "node:assert/strict";
import {
  projectHistoryProjection,
  assertRequestDefinitionProjectBudget,
  sameHistoryJSON,
  validateRequestDefinitionHistory,
  reconcileRequestDefinitionHistory,
  listRequestDefinitionHistory,
  getRequestDefinitionVersion,
  applyRequestDefinitionHistoryOperation,
  REQUEST_DEFINITION_HISTORY_MAX_BYTES,
  REQUEST_DEFINITION_HISTORY_ENVELOPE_MAX_BYTES,
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
  assert.equal(entry(project).versions[0].definition.deletedAt, undefined);
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
  assert.equal(
    listRequestDefinitionHistory(project, { requestId: "a" }).selectionRequired,
    true,
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
  unchangedFailure(oversized, () => edited(oversized, "new"), /容量/);
  const total = edited(initial());
  const template = entry(total).versions[0];
  entry(total).versions = Array.from({ length: 9 }, (_, i) => ({
    ...clone(template),
    id: "large-" + i,
    version: i + 1,
    definition: { id: "a", body: "x".repeat(4 * 1024 * 1024) },
  }));
  entry(total).currentVersion = 10;
  assert.ok(
    Buffer.byteLength(JSON.stringify(total.requestDefinitionHistory)) >
      REQUEST_DEFINITION_HISTORY_MAX_BYTES,
  );
  unchangedFailure(
    total,
    () => validateRequestDefinitionHistory(total),
    /容量/,
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

test("retired lineages are discoverable through bounded independent metadata pagination", () => {
  let project = initial();
  const ids = [];
  for (let index = 0; index < 4; index++) {
    ids.push(entry(project).lineageId);
    let next = clone(project);
    next.requests = next.requests.filter((request) => request.id !== "a");
    project = save(project, next);
    if (index < 3) {
      next = clone(project);
      next.requests.push({
        ...fixture().requests[0],
        body: "replacement-" + index,
      });
      project = save(project, next);
    }
  }
  const listed = listRequestDefinitionHistory(project, {
    requestId: "a",
    lineageOffset: 1,
    lineageLimit: 2,
  });
  assert.equal(listed.selectionRequired, true);
  assert.equal(listed.lineageId, null);
  assert.equal(listed.current, null);
  assert.deepEqual(listed.versions, []);
  assert.equal(listed.lineages.total, 4);
  assert.equal(listed.lineages.offset, 1);
  assert.equal(listed.lineages.limit, 2);
  assert.deepEqual(
    listed.lineages.items.map((lineage) => lineage.lineageId),
    ids.toReversed().slice(1, 3),
  );
  assert.ok(
    listed.lineages.items.every(
      (lineage) =>
        lineage.retired &&
        lineage.currentVersion === 1 &&
        lineage.total === 1 &&
        !Object.hasOwn(lineage, "definition"),
    ),
  );
  const selected = listRequestDefinitionHistory(project, {
    requestId: "a",
    lineageId: ids[0],
    lineageLimit: 1,
    limit: 1,
  });
  assert.equal(selected.selectionRequired, false);
  assert.equal(selected.lineageId, ids[0]);
  assert.equal(selected.versions.length, 1);
  assert.equal(selected.lineages.items.length, 1);
  assert.throws(
    () =>
      getRequestDefinitionVersion(project, {
        requestId: "a",
        historyId: selected.versions[0].id,
      }),
    /指定/,
  );
  const version = getRequestDefinitionVersion(project, {
    requestId: "a",
    lineageId: ids[0],
    historyId: selected.versions[0].id,
  });
  assert.equal(version.definition.body, "first");
  for (const query of [
    { lineageOffset: -1 },
    { lineageOffset: 10001 },
    { lineageOffset: 0.5 },
    { lineageLimit: 0 },
    { lineageLimit: 101 },
    { lineageLimit: "20" },
  ])
    assert.throws(() =>
      listRequestDefinitionHistory(project, { requestId: "a", ...query }),
    );
});

test("history reads ignore unrelated execution bytes and descriptors", () => {
  const project = edited(initial());
  project.history = [
    { id: "large-execution", body: "x".repeat(13 * 1024 * 1024) },
  ];
  const oldId = entry(project).versions[0].id;
  assert.doesNotThrow(() => validateRequestDefinitionHistory(project));
  assert.equal(
    listRequestDefinitionHistory(project, { requestId: "a" }).total,
    1,
  );
  assert.equal(
    getRequestDefinitionVersion(project, { requestId: "a", historyId: oldId })
      .definition.body,
    "first",
  );
  assert.equal(
    getRequestDefinitionVersion(project, {
      requestId: "a",
      historyId: "current",
    }).definition.body,
    "second",
  );
  let reads = 0;
  Object.defineProperty(project, "runs", {
    enumerable: true,
    get() {
      reads++;
      throw Error("unrelated execution getter");
    },
  });
  assert.doesNotThrow(() => validateRequestDefinitionHistory(project));
  assert.equal(
    listRequestDefinitionHistory(project, { requestId: "a" }).total,
    1,
  );
  assert.equal(
    getRequestDefinitionVersion(project, { requestId: "a", historyId: oldId })
      .definition.body,
    "first",
  );
  assert.equal(reads, 0);
});

test("activity may add execution evidence beyond 12MiB but cannot change definitions or history", () => {
  const project = edited(initial());
  project.history = [
    { id: "large-execution", body: "x".repeat(13 * 1024 * 1024) },
  ];
  const next = clone(project);
  next.runs.push({ id: "new-run", outcome: "preserved" });
  next.protocolRuns = [{ id: "protocol-run", response: "preserved" }];
  assert.equal(
    reconcileRequestDefinitionHistory(project, next, { activity: true }),
    project.requestDefinitionHistory,
  );
  const editedDefinition = clone(next);
  editedDefinition.requests[0].body = "must not bypass";
  assert.throws(
    () =>
      reconcileRequestDefinitionHistory(project, editedDefinition, {
        activity: true,
      }),
    /运行活动/,
  );
  const editedHistory = clone(next);
  entry(editedHistory).currentTag = "must not bypass";
  assert.throws(
    () =>
      reconcileRequestDefinitionHistory(project, editedHistory, {
        activity: true,
      }),
    /运行活动/,
  );
  let reads = 0;
  Object.defineProperty(next, "unrelatedExecution", {
    enumerable: true,
    get() {
      reads++;
      throw Error("not definition data");
    },
  });
  assert.equal(
    reconcileRequestDefinitionHistory(project, next, { activity: true }),
    project.requestDefinitionHistory,
  );
  assert.equal(reads, 0);
});

test("clearing history preserves execution evidence while reducing independent backup size", () => {
  let project = initial();
  project.requests[0].body = "old-body-" + "x".repeat(900000);
  project = edited(project, "current-small-body");
  project.history = [
    { id: "execution", body: "x".repeat(12 * 1024 * 1024 - 400000) },
  ];
  assert.ok(
    Buffer.byteLength(JSON.stringify({ document: project })) > 12 * 1024 * 1024,
  );
  const cleared = operation(project, "clear", { all: true });
  assert.equal(entry(cleared).versions.length, 0);
  assert.deepEqual(cleared.history, project.history);
  assert.ok(
    Buffer.byteLength(JSON.stringify({ document: cleared })) < 12 * 1024 * 1024,
  );
  const saved = save(project, cleared);
  assert.equal(entry(saved).currentVersion, entry(project).currentVersion);
  assert.equal(entry(saved).lineageId, entry(project).lineageId);
  assert.equal(entry(saved).versions.length, 0);
  assert.equal(entry(project).versions.length, 1);
});

test("configuration saves are not gated by the optional backup-size utility", () => {
  const project = edited(initial());
  project.history = [
    { id: "large-execution", body: "x".repeat(13 * 1024 * 1024) },
  ];
  const next = clone(project);
  next.name = "configuration change";
  assert.throws(
    () => assertRequestDefinitionProjectBudget(next),
    /体积超过12582912/,
  );
  assert.doesNotThrow(() => save(project, next));
  const reduced = clone(next);
  reduced.history = [];
  assert.doesNotThrow(() => save(project, reduced));
  assert.doesNotThrow(() => save(undefined, next));
});

test("history operations reject top-level getters and leave borrowed unrelated proxies untouched", () => {
  const project = edited(initial());
  let reads = 0;
  Object.defineProperty(project, "executionGetter", {
    enumerable: true,
    get() {
      reads++;
      throw Error("must not execute");
    },
  });
  assert.throws(() => operation(project, "clear", { all: true }), /访问器/);
  assert.equal(reads, 0);
  const proxyProject = edited(initial());
  proxyProject.runs = new Proxy([], {
    ownKeys() {
      reads++;
      throw Error("must not execute");
    },
  });
  const cleared = operation(proxyProject, "clear", { all: true });
  assert.equal(cleared.runs, proxyProject.runs);
  assert.equal(reads, 0);
});

test("JSON comparison accepts explicit budgets independently of history storage quotas", () => {
  const definitions = Array.from({ length: 10 }, (_, index) => ({
    id: "request-" + index,
    body: "x".repeat(900000),
  }));
  const project = {
    id: "large-definitions-project",
    requests: definitions,
    requestDefinitionHistory: {
      version: 1,
      projectId: "large-definitions-project",
      entries: [],
    },
  };
  const persisted = clone(project);
  assert.throws(
    () =>
      sameHistoryJSON(definitions, persisted.requests, {
        maxBytes: 8 * 1024 * 1024,
      }),
    /体积/,
  );
  assert.equal(
    sameHistoryJSON(definitions, persisted.requests, {
      maxBytes: 12 * 1024 * 1024,
    }),
    true,
  );
  assert.equal(
    reconcileRequestDefinitionHistory(project, persisted, { activity: true }),
    project.requestDefinitionHistory,
  );
});

test("an explicit restore of an identical old definition still archives current and advances version", () => {
  let project = initial();
  project = save(
    project,
    operation(project, "tag", { historyId: "current", tag: "original A" }),
  );
  project = edited(project);
  const originalId = entry(project).versions[0].id;
  project = save(
    project,
    operation(project, "restore", { historyId: originalId }),
    { restoredRequestId: "a" },
  );
  project = save(
    project,
    operation(project, "tag", {
      historyId: "current",
      tag: "before repeated restore",
    }),
  );
  const before = clone(project);
  const draft = operation(project, "restore", { historyId: originalId });
  assert.deepEqual(draft.requests[0], project.requests[0]);
  const ordinary = save(project, draft);
  assert.equal(entry(ordinary).currentVersion, 3);
  const restored = save(project, draft, { restoredRequestId: "a" });
  assert.equal(entry(restored).currentVersion, 4);
  assert.equal(entry(restored).versions.length, 3);
  assert.equal(entry(restored).versions.at(-1).version, 3);
  assert.equal(entry(restored).versions.at(-1).tag, "before repeated restore");
  assert.equal(entry(restored).versions[0].tag, "original A");
  assert.deepEqual(
    entry(restored).versions.slice(0, 2),
    entry(before).versions,
  );
  assert.deepEqual(restored.requests, before.requests);
  assert.deepEqual(entry(restored, "b"), entry(before, "b"));
  assert.deepEqual(project, before);
});

test("forced restore context cannot create, revive, retarget or run as activity", () => {
  const project = edited(initial());
  assert.throws(
    () => save(undefined, project, { restoredRequestId: "a" }),
    /恢复/,
  );
  assert.throws(
    () => save(project, project, { restoredRequestId: "missing" }),
    /恢复/,
  );
  assert.throws(
    () =>
      reconcileRequestDefinitionHistory(project, project, {
        activity: true,
        restoredRequestId: "a",
      }),
    /恢复/,
  );
  const removed = clone(project);
  removed.requests = removed.requests.filter((request) => request.id !== "a");
  assert.throws(
    () => save(project, removed, { restoredRequestId: "a" }),
    /恢复/,
  );
  const retired = save(project, removed);
  assert.throws(
    () => save(retired, project, { restoredRequestId: "a" }),
    /恢复/,
  );
  const deleted = clone(project);
  deleted.requests[0].deletedAt = now;
  assert.throws(
    () => save(deleted, project, { restoredRequestId: "a" }),
    /恢复/,
  );
  assert.throws(
    () => save(project, deleted, { restoredRequestId: "a" }),
    /恢复/,
  );
  const archived = clone(project);
  archived.archived = true;
  assert.throws(
    () => save(archived, project, { restoredRequestId: "a" }),
    /恢复/,
  );
  assert.throws(
    () => save(project, archived, { restoredRequestId: "a" }),
    /恢复/,
  );
});

test("current creation and edits do not reserve future snapshot quota", () => {
  const large = fixture();
  large.requests[0].body = "x".repeat(
    REQUEST_DEFINITION_SNAPSHOT_MAX_BYTES + 1,
  );
  const created = save(undefined, large);
  assert.equal(entry(created).versions.length, 0);
  const project = initial();
  const added = clone(project);
  added.requests.push({ id: "new-large", body: large.requests[0].body });
  assert.equal(entry(save(project, added), "new-large").versions.length, 0);
  const changed = clone(project);
  changed.requests[0].body = large.requests[0].body;
  const saved = save(project, changed);
  assert.equal(entry(saved).versions.length, 1);
  assert.equal(entry(saved).versions[0].definition.body, "first");
});

test("large preexisting current remains readable and permits activity, no-op, tag and clear", () => {
  const legacy = fixture();
  legacy.requests[0].body = "x".repeat(2 * 1024 * 1024);
  assert.equal(
    listRequestDefinitionHistory(legacy, { requestId: "a" }).tracked,
    false,
  );
  assert.equal(
    getRequestDefinitionVersion(legacy, {
      requestId: "a",
      historyId: "current",
    }).definition.body,
    legacy.requests[0].body,
  );
  assert.equal(
    reconcileRequestDefinitionHistory(legacy, legacy, { activity: true }),
    undefined,
  );
  let project = save(legacy, legacy);
  assert.equal(entry(project).versions.length, 0);
  assert.equal(entry(project).currentVersion, 1);
  project = save(
    project,
    operation(project, "tag", {
      historyId: "current",
      tag: "existing large definition",
    }),
  );
  assert.equal(entry(project).currentTag, "existing large definition");
  project = save(project, operation(project, "clear", { all: true }));
  assert.equal(entry(project).currentVersion, 1);
  assert.equal(entry(project).versions.length, 0);
  assert.equal(project.requests[0].body, legacy.requests[0].body);
  assert.equal(
    reconcileRequestDefinitionHistory(project, project, { activity: true }),
    project.requestDefinitionHistory,
  );
});

test("a current exceeding the full-record quota cannot be edited or hard-removed without history", () => {
  const legacy = fixture();
  legacy.requests[0].body = "x".repeat(REQUEST_DEFINITION_SNAPSHOT_MAX_BYTES);
  const changed = clone(legacy);
  changed.requests[0].body = "small replacement";
  unchangedFailure(
    legacy,
    () => save(legacy, changed),
    /单条历史容量超过 16 MiB/,
  );
  const removed = clone(legacy);
  removed.requests = removed.requests.filter((request) => request.id !== "a");
  unchangedFailure(
    legacy,
    () => save(legacy, removed),
    /单条历史容量超过 16 MiB/,
  );
});

test("history operations borrow unrelated committed evidence without new depth or node gates", () => {
  const project = edited(initial());
  let deep = { value: "execution evidence" };
  for (let index = 0; index < 100; index++) deep = { nested: deep };
  project.history = [{ id: "deep-execution", response: deep }];
  project.runs = Array.from({ length: 100001 }, (_, index) => ({
    id: "run-" + index,
  }));
  let reads = 0;
  const unrelated = {};
  Object.defineProperty(unrelated, "nestedGetter", {
    enumerable: true,
    get() {
      reads++;
      throw Error("must not execute");
    },
  });
  project.protocolRuns = [unrelated];
  const cleared = operation(project, "clear", { all: true });
  assert.equal(cleared.history, project.history);
  assert.equal(cleared.runs, project.runs);
  assert.equal(cleared.protocolRuns, project.protocolRuns);
  assert.notEqual(cleared.requests, project.requests);
  assert.notEqual(
    cleared.requestDefinitionHistory,
    project.requestDefinitionHistory,
  );
  assert.equal(entry(cleared).versions.length, 0);
  assert.equal(entry(project).versions.length, 1);
  assert.equal(reads, 0);
});

test("configuration history preserves existing deep environment and settings persistence contracts", () => {
  const project = fixture();
  let deep = {};
  for (let index = 0; index < 150; index++) deep = { child: deep };
  project.environments = [{ id: "environment", variables: { deep } }];
  project.settings = { deep };
  const saved = save(undefined, project);
  assert.deepEqual(saved.environments, project.environments);
  assert.deepEqual(saved.settings, project.settings);
  assert.equal(entry(saved).versions.length, 0);
  const next = clone(saved);
  next.requests[0].body = "edit only selected definition";
  const changed = save(saved, next);
  assert.deepEqual(changed.settings, project.settings);
  assert.equal(entry(changed).currentVersion, 2);
});

test("unrelated valid JSON collections do not inherit history array and node limits", () => {
  const project = fixture();
  project.environments = [
    {
      id: "environment",
      variables: {
        many: Array.from({ length: 160000 }, (_, index) => ({
          value: index,
          enabled: true,
        })),
      },
    },
  ];
  assert.ok(
    Buffer.byteLength(JSON.stringify({ document: project })) < 12 * 1024 * 1024,
  );
  const saved = save(undefined, project);
  assert.equal(saved.environments[0].variables.many.length, 160000);
  assert.equal(entry(saved).versions.length, 0);
});

test("project envelope byte counting is exact and iterative without weakening feature limits", () => {
  const project = {
    id: "budget-fixture",
    settings: JSON.parse(
      '{"constructor":{"safe":true},"__proto__":{"safe":true},"quoted":"\\\"\\n","unicode":"界é"}',
    ),
    omitted: undefined,
    zero: -0,
    data: [false, null, 1.25, "\ud800"],
  };
  assert.equal(
    assertRequestDefinitionProjectBudget(project),
    Buffer.byteLength(JSON.stringify({ document: project })),
  );
  let deep = {};
  for (let index = 0; index < 10000; index++) deep = { child: deep };
  assert.equal(
    assertRequestDefinitionProjectBudget({ settings: deep }),
    Buffer.byteLength(JSON.stringify({ document: { settings: {} } })) +
      10000 * 10,
  );
  const feature = fixture();
  let schema = {};
  for (let index = 0; index < 70; index++) schema = { child: schema };
  feature.requests[0].schema = schema;
  assert.throws(() => save(undefined, feature), /结构/);
  const current = edited(initial());
  entry(current).versions[0].definition.schema = schema;
  assert.throws(() => validateRequestDefinitionHistory(current), /结构/);
});

test("whole-project byte counting rejects hostile descriptors without executing them", () => {
  let calls = 0;
  const getter = {};
  Object.defineProperty(getter, "value", {
    enumerable: true,
    get() {
      calls++;
      throw Error("executed");
    },
  });
  const proxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        calls++;
        throw Error("executed");
      },
      ownKeys() {
        calls++;
        throw Error("executed");
      },
    },
  );
  const cycle = {};
  cycle.self = cycle;
  const sparse = [];
  sparse.length = 2;
  sparse[1] = 1;
  const extra = [1];
  extra.hidden = 2;
  const hidden = {};
  Object.defineProperty(hidden, "hidden", { value: true });
  const toJSON = {
    toJSON() {
      calls++;
      throw Error("executed");
    },
  };
  for (const value of [
    getter,
    proxy,
    cycle,
    sparse,
    extra,
    hidden,
    toJSON,
    { value: Infinity },
    { value: 1n },
    { [Symbol("key")]: true },
    [undefined],
  ]) {
    let nested = value;
    for (let index = 0; index < 100; index++) nested = { child: nested };
    assert.throws(() =>
      assertRequestDefinitionProjectBudget({ settings: nested }),
    );
  }
  assert.equal(calls, 0);
  assert.throws(
    () =>
      assertRequestDefinitionProjectBudget({
        settings: "x".repeat(12 * 1024 * 1024),
      }),
    /体积超过12582912/,
  );
});

test("8MiB current definitions can be created and archived by two ordinary edits", () => {
  const project = fixture();
  project.requests[0].body = "A".repeat(8 * 1024 * 1024);
  let saved = save(undefined, project);
  assert.equal(entry(saved).versions.length, 0);
  saved = edited(saved, "B".repeat(8 * 1024 * 1024));
  assert.equal(entry(saved).currentVersion, 2);
  assert.equal(
    entry(saved).versions[0].definition.body,
    project.requests[0].body,
  );
  saved = edited(saved, "C".repeat(8 * 1024 * 1024));
  assert.equal(entry(saved).currentVersion, 3);
  assert.equal(entry(saved).versions.length, 2);
  assert.equal(
    entry(saved).versions[1].definition.body,
    "B".repeat(8 * 1024 * 1024),
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify({ document: saved })) > 12 * 1024 * 1024,
  );
});

test("history quotas are independent of the complete project backup size", () => {
  const project = initial();
  project.history = [
    { id: "existing-evidence", body: "x".repeat(13 * 1024 * 1024) },
  ];
  const changed = edited(project);
  assert.equal(entry(changed).currentVersion, 2);
  assert.deepEqual(changed.history, project.history);
  assert.equal(entry(changed).versions.length, 1);
});

test("the 16MiB single-version quota includes encoded quotes, backslashes and all metadata", () => {
  const project = initial();
  const expected = {
    id: "boundary-version",
    version: 1,
    createdAt: now,
    tag: "",
    definition: { ...clone(project.requests[0]), body: "" },
  };
  const remaining =
    16 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(expected));
  expected.definition.body =
    '"\\'.repeat(Math.floor(remaining / 4)) + "x".repeat(remaining % 4);
  assert.equal(Buffer.byteLength(JSON.stringify(expected)), 16 * 1024 * 1024);
  project.requests[0] = clone(expected.definition);
  const saved = edited(project, "small replacement", "a", {
    makeId: () => "boundary-version",
  });
  assert.deepEqual(entry(saved).versions[0], expected);
  assert.doesNotThrow(() => validateRequestDefinitionHistory(saved));
  unchangedFailure(
    saved,
    () => operation(saved, "tag", { historyId: "boundary-version", tag: "x" }),
    (error) => {
      assert.equal(error.code, "REQUEST_DEFINITION_HISTORY_CAPACITY");
      assert.match(error.message, /单条历史容量超过 16 MiB/);
      assert.match(error.message, /GET \/api\/projects\/project-a\/export/);
      assert.match(
        error.message,
        /POST \/api\/projects\/project-a\/definition-history/,
      );
      assert.match(error.message, /localapi_clear_api_definition_history/);
      return true;
    },
  );
  const oversized = clone(project);
  oversized.requests[0].body += "\\";
  unchangedFailure(
    oversized,
    () =>
      edited(oversized, "small replacement", "a", {
        makeId: () => "boundary-version",
      }),
    /单条历史容量超过 16 MiB/,
  );
});

test("32MiB total quota is exact, rejects the whole mutation, and permits explicit cleanup", () => {
  const project = initial();
  const tracker = entry(project);
  tracker.currentVersion = 3;
  tracker.versions = [1, 2].map((version) => ({
    id: "total-boundary-" + version,
    version,
    createdAt: now,
    tag: "",
    definition: { id: "a", body: "" },
  }));
  const remaining =
    32 * 1024 * 1024 -
    Buffer.byteLength(
      JSON.stringify({ ...project.requestDefinitionHistory, projectId: "a" }),
    );
  const first = Math.floor(remaining / 2);
  tracker.versions[0].definition.body = "q".repeat(first);
  const second = remaining - first;
  tracker.versions[1].definition.body =
    "\\".repeat(Math.floor(second / 2)) + "x".repeat(second % 2);
  assert.equal(
    Buffer.byteLength(JSON.stringify(project.requestDefinitionHistory)),
    32 * 1024 * 1024 + project.id.length - 1,
  );
  assert.ok(
    tracker.versions.every(
      (version) =>
        Buffer.byteLength(JSON.stringify(version)) <= 16 * 1024 * 1024,
    ),
  );
  assert.doesNotThrow(() => validateRequestDefinitionHistory(project));
  unchangedFailure(
    project,
    () => operation(project, "tag", { historyId: "current", tag: "x" }),
    /项目历史总容量超过 32 MiB/,
  );
  unchangedFailure(
    project,
    () => edited(project),
    (error) => {
      assert.match(error.message, /项目历史总容量超过 32 MiB/);
      assert.match(error.message, /导出完整项目/);
      assert.match(error.message, /kind: "clear", confirm: true/);
      return true;
    },
  );
  const cleared = save(
    project,
    operation(project, "clear", { historyIds: [tracker.versions[0].id] }),
  );
  assert.equal(entry(cleared).currentVersion, 3);
  assert.equal(entry(cleared).versions.length, 1);
  const editedAfterCleanup = edited(cleared);
  assert.equal(entry(editedAfterCleanup).currentVersion, 4);
  assert.equal(entry(editedAfterCleanup).versions.length, 2);
  assert.equal(entry(project).versions.length, 2);
});

function quotaRetentionFixture(largeOldest) {
  const project = initial();
  project.requests[0].body = "current" + "x".repeat(8 * 1024 * 1024);
  const a = entry(project);
  a.currentVersion = 101;
  a.versions = Array.from({ length: 100 }, (_, index) => ({
    id: "retention-a-" + index,
    version: index + 1,
    createdAt: now,
    tag: "",
    definition: {
      id: "a",
      body:
        index === (largeOldest ? 0 : 99)
          ? "x".repeat(14 * 1024 * 1024)
          : "small",
    },
  }));
  const b = entry(project, "b");
  b.currentVersion = 2;
  b.versions = [
    {
      id: "retention-b",
      version: 1,
      createdAt: now,
      tag: "",
      definition: { id: "b", body: "x".repeat(15 * 1024 * 1024) },
    },
  ];
  validateRequestDefinitionHistory(project);
  return project;
}

test("the 100-version retention crop happens before total quota enforcement without extra eviction", () => {
  const cropOldest = quotaRetentionFixture(true);
  const originalPeer = entry(cropOldest, "b");
  const saved = edited(cropOldest, "next current");
  assert.equal(entry(saved).versions.length, 100);
  assert.equal(entry(saved).versions[0].version, 2);
  assert.equal(entry(saved).versions.at(-1).version, 101);
  assert.equal(entry(saved).currentVersion, 102);
  assert.deepEqual(entry(saved, "b"), originalPeer);
  assert.ok(
    Buffer.byteLength(JSON.stringify(saved.requestDefinitionHistory)) <
      32 * 1024 * 1024,
  );
  const cannotFit = quotaRetentionFixture(false);
  unchangedFailure(
    cannotFit,
    () => edited(cannotFit, "next current"),
    /项目历史总容量超过 32 MiB/,
  );
  assert.equal(entry(cannotFit).versions.length, 100);
  assert.equal(entry(cannotFit).versions[0].version, 1);
  assert.equal(entry(cannotFit).currentVersion, 101);
});

function fullQuotaOwnerFixture() {
  const project = initial();
  project.id = "a";
  project.requestDefinitionHistory.projectId = "a";
  const tracker = entry(project);
  tracker.currentVersion = 3;
  tracker.versions = [1, 2].map((version) => ({
    id: "owner-boundary-" + version,
    version,
    createdAt: now,
    tag: "",
    definition: { id: "a", body: "" },
  }));
  const remaining =
    32 * 1024 * 1024 -
    Buffer.byteLength(JSON.stringify(project.requestDefinitionHistory));
  tracker.versions[0].definition.body = "x".repeat(Math.floor(remaining / 2));
  tracker.versions[1].definition.body = "y".repeat(
    remaining - Math.floor(remaining / 2),
  );
  assert.equal(
    Buffer.byteLength(JSON.stringify(project.requestDefinitionHistory)),
    32 * 1024 * 1024,
  );
  return project;
}

test("a full 32MiB history remains valid when a short owner is rebound to a UUID", () => {
  const project = fullQuotaOwnerFixture();
  assert.doesNotThrow(() => validateRequestDefinitionHistory(project));
  const restored = {
    ...project,
    id: "12345678-1234-1234-1234-123456789012",
    requestDefinitionHistory: {
      ...project.requestDefinitionHistory,
      projectId: "12345678-1234-1234-1234-123456789012",
    },
  };
  assert.equal(
    Buffer.byteLength(JSON.stringify(restored.requestDefinitionHistory)),
    32 * 1024 * 1024 + 35,
  );
  assert.doesNotThrow(() => validateRequestDefinitionHistory(restored));
});

test("owner length changes neither full-quota reads nor operations or one-byte overflow rejection", () => {
  const original = fullQuotaOwnerFixture();
  const expected = entry(original);
  const owners = [
    "a",
    "12345678-1234-1234-1234-123456789012",
    "z".repeat(200),
    "a",
  ];
  assert.equal(
    REQUEST_DEFINITION_HISTORY_ENVELOPE_MAX_BYTES,
    REQUEST_DEFINITION_HISTORY_MAX_BYTES + 199,
  );
  for (const owner of owners) {
    const project = {
      ...original,
      id: owner,
      requestDefinitionHistory: {
        ...original.requestDefinitionHistory,
        projectId: owner,
      },
    };
    const actual = Buffer.byteLength(
      JSON.stringify(project.requestDefinitionHistory),
    );
    assert.equal(
      actual,
      REQUEST_DEFINITION_HISTORY_MAX_BYTES + owner.length - 1,
    );
    assert.ok(actual <= REQUEST_DEFINITION_HISTORY_ENVELOPE_MAX_BYTES);
    assert.doesNotThrow(() => validateRequestDefinitionHistory(project));
    const listed = listRequestDefinitionHistory(project, { requestId: "a" });
    assert.equal(listed.total, 2);
    assert.equal(listed.lineageId, expected.lineageId);
    const selected = getRequestDefinitionVersion(project, {
      requestId: "a",
      lineageId: expected.lineageId,
      historyId: expected.versions[0].id,
    });
    assert.equal(
      selected.definition.body,
      expected.versions[0].definition.body,
    );
    const tagged = operation(project, "tag", { historyId: "current", tag: "" });
    assert.equal(tagged.requestDefinitionHistory.projectId, owner);
    assert.deepEqual(entry(tagged), expected);
    const over = {
      ...project,
      requestDefinitionHistory: {
        ...project.requestDefinitionHistory,
        entries: project.requestDefinitionHistory.entries.map((item) =>
          item.requestId === "a" ? { ...item, currentTag: "x" } : item,
        ),
      },
    };
    assert.throws(
      () => validateRequestDefinitionHistory(over),
      /项目历史总容量超过 32 MiB/,
    );
    assert.throws(
      () => operation(project, "tag", { historyId: "current", tag: "x" }),
      /项目历史总容量超过 32 MiB/,
    );
    assert.equal(entry(project).currentTag, "");
    if (owner.length === 200) {
      assert.equal(actual, REQUEST_DEFINITION_HISTORY_ENVELOPE_MAX_BYTES);
      assert.throws(
        () => projectHistoryProjection(project.requestDefinitionHistory),
        /体积/,
      );
      assert.doesNotThrow(() =>
        projectHistoryProjection(project.requestDefinitionHistory, {
          maxBytes: REQUEST_DEFINITION_HISTORY_ENVELOPE_MAX_BYTES,
        }),
      );
      assert.throws(
        () =>
          projectHistoryProjection(over.requestDefinitionHistory, {
            maxBytes: REQUEST_DEFINITION_HISTORY_ENVELOPE_MAX_BYTES,
          }),
        /体积/,
      );
      const cleared = operation(project, "clear", {
        historyIds: [expected.versions[0].id],
      });
      assert.equal(entry(cleared).versions.length, 1);
      assert.equal(entry(cleared).currentVersion, 3);
    }
  }
  assert.equal(original.id, "a");
  assert.equal(original.requestDefinitionHistory.projectId, "a");
  assert.equal(entry(original).versions.length, 2);
});

test("invalid or mismatched owners cannot use the history envelope allowance", () => {
  const original = fullQuotaOwnerFixture();
  for (const [projectId, owner] of [
    ["a", "b"],
    ["界", "界"],
    ["x".repeat(201), "x".repeat(201)],
    ["a", "x".repeat(201)],
    ["a", "bad/id"],
  ]) {
    const project = {
      ...original,
      id: projectId,
      requestDefinitionHistory: {
        ...original.requestDefinitionHistory,
        projectId: owner,
      },
    };
    assert.throws(
      () => validateRequestDefinitionHistory(project),
      /项目ID|归属/,
    );
  }
  let calls = 0;
  const history = { ...original.requestDefinitionHistory };
  Object.defineProperty(history, "projectId", {
    enumerable: true,
    get() {
      calls++;
      return "a";
    },
  });
  assert.throws(
    () =>
      validateRequestDefinitionHistory({
        ...original,
        requestDefinitionHistory: history,
      }),
    /访问器/,
  );
  assert.equal(calls, 0);
});
