import test from "node:test";
import assert from "node:assert/strict";
import {
  deleteAPIResources,
  validateAPIResourceTrash,
} from "../src/api-resource-lifecycle.mjs";
import {
  restoreAPIResources,
  assertAPIResourceTrashIdentity,
} from "../src/api-resource-restore.mjs";

const restoredAt = "2026-10-31T16:00:00.000Z";
const clone = (value) => structuredClone(value);
function fixture() {
  return {
    id: "project",
    name: "plain model fixture",
    archived: false,
    folders: ["Parent", "Parent/A", "Parent/A/Child", "Parent/AB", "Empty"],
    requests: [
      {
        id: "http-a",
        name: "a",
        method: "POST",
        url: "https://example.invalid/a",
        folder: "Parent/A/Child",
        body: { raw: "retained" },
      },
      {
        id: "http-sibling",
        name: "sibling",
        method: "GET",
        url: "https://example.invalid/b",
        folder: "Parent/AB",
      },
    ],
    documents: [
      {
        id: "doc-a",
        title: "a",
        content: "original",
        folder: "Parent/A",
        attributes: { note: "kept" },
      },
      {
        id: "doc-child",
        title: "child",
        content: "child",
        folder: "Parent/A/Child",
      },
      {
        id: "doc-sibling",
        title: "sibling",
        content: "sibling",
        folder: "Parent/AB",
      },
    ],
    settings: {
      folderParameters: {
        "Parent/A": { headers: [{ key: "X-Fixture", value: "a" }] },
        "Parent/AB": {},
      },
      folderAuth: {
        "Parent/A": { type: "bearer", token: "fixture" },
        "Parent/AB": { type: "none" },
      },
      folderScripts: {
        "Parent/A/Child": {
          beforeScript: "fixture-only-source",
          enabled: true,
        },
        "Parent/AB": {},
      },
      folderServices: { "Parent/A": "service-a", "Parent/AB": "service-b" },
      unrelated: { preserved: true },
    },
    cases: [{ id: "case", evidence: [1, 2] }],
    plans: [{ id: "plan" }],
    history: [{ id: "history" }],
    runs: [{ id: "run", frozen: { value: "unchanged" } }],
  };
}
function deleted() {
  return deleteAPIResources(fixture(), ["folder:Parent/A", "folder:Empty"])
    .project;
}
function restore(project, id = project.apiResourceTrash.batches[0].id) {
  return restoreAPIResources(project, id, { restoredAt });
}
function unchangedFailure(input, fn, pattern) {
  const before = clone(input);
  assert.throws(fn, pattern);
  assert.deepEqual(input, before, "rejection must not mutate input");
}
function docBatch(id, docId = "doc", marker) {
  return {
    id,
    deletedAt: "2026-10-30T00:00:00.000Z",
    ...(marker ? { restoredAt } : {}),
    selectedTargetIds: [docId],
    folderPaths: [],
    explicitFolders: [],
    requestIds: [],
    documents: [{ id: docId, title: "doc", content: "body" }],
    folderSettings: {},
  };
}
function projectWith(batches) {
  return {
    requests: [],
    documents: [],
    folders: [],
    settings: {},
    apiResourceTrash: { version: 1, batches },
  };
}

test("mixed resources delete/restore/edit/redelete/restore retains history, definitions and detached state", () => {
  const original = fixture(),
    originalCopy = clone(original);
  const removed = deleteAPIResources(original, [
    "folder:Parent/A",
    "folder:Empty",
  ]).project;
  assert.deepEqual(original, originalCopy);
  const batchCopy = clone(removed.apiResourceTrash.batches[0]);
  assert.deepEqual(batchCopy.requestIds, ["http-a"]);
  assert.equal(
    Object.hasOwn(batchCopy, "requests"),
    false,
    "no invented HTTP snapshots",
  );
  removed.requests[0].body.raw = "edited while deleted";
  const removedCopy = clone(removed);
  const result = restore(removed),
    current = result.project;
  assert.deepEqual(removed, removedCopy);
  assert.deepEqual(result.restoredTargetIds, batchCopy.selectedTargetIds);
  assert.equal(current.requests[0].body.raw, "edited while deleted");
  assert.equal(Object.hasOwn(current.requests[0], "deletedAt"), false);
  assert.deepEqual([...current.folders].sort(), [...original.folders].sort());
  assert.deepEqual(current.settings, original.settings);
  for (const key of ["cases", "plans", "history", "runs"])
    assert.deepEqual(current[key], original[key]);
  assert.deepEqual(current.apiResourceTrash.batches[0], {
    ...batchCopy,
    restoredAt,
  });
  const doc = current.documents.find((x) => x.id === "doc-a");
  doc.content = "edited after restore";
  doc.attributes.note = "new";
  assert.equal(
    current.apiResourceTrash.batches[0].documents.find((x) => x.id === doc.id)
      .content,
    "original",
  );
  assert.equal(
    current.apiResourceTrash.batches[0].documents.find((x) => x.id === doc.id)
      .attributes.note,
    "kept",
  );
  assert.deepEqual(removed, removedCopy);
  const removedAgain = deleteAPIResources(current, ["doc-a"]).project;
  const last = removedAgain.apiResourceTrash.batches.at(-1);
  assert.equal(last.documents[0].content, "edited after restore");
  const restoredAgain = restore(removedAgain, last.id).project;
  assert.equal(
    restoredAgain.documents.find((x) => x.id === doc.id).content,
    "edited after restore",
  );
  assert.equal(restoredAgain.apiResourceTrash.batches.length, 2);
  assert.deepEqual(
    restoredAgain.apiResourceTrash.batches[0],
    current.apiResourceTrash.batches[0],
  );
  assert.notEqual(
    restoredAgain.documents.find((x) => x.id === doc.id),
    restoredAgain.apiResourceTrash.batches[1].documents[0],
  );
  assert.doesNotThrow(() => validateAPIResourceTrash(restoredAgain));
});

test("codec historical document identity rules and cross-type conflicts", () => {
  const allowed = projectWith([
    docBatch("old", "doc", true),
    docBatch("pending"),
  ]);
  assert.doesNotThrow(() => validateAPIResourceTrash(allowed));
  allowed.apiResourceTrash.batches[1].restoredAt = restoredAt;
  allowed.documents = [{ id: "doc", title: "current", content: "edited" }];
  assert.doesNotThrow(() => validateAPIResourceTrash(allowed));
  const invalid = [];
  const duplicate = projectWith([docBatch("a")]);
  duplicate.apiResourceTrash.batches[0].documents.push(
    clone(duplicate.apiResourceTrash.batches[0].documents[0]),
  );
  invalid.push(duplicate);
  invalid.push(projectWith([docBatch("a"), docBatch("b")]));
  for (const type of [
    "requests",
    "protocols",
    "grpcDefinitions",
    "socketioDefinitions",
  ]) {
    const p = projectWith([docBatch("old", "doc", true)]);
    if (type.endsWith("Definitions")) p.settings[type] = [{ id: "doc" }];
    else p[type] = [{ id: "doc" }];
    invalid.push(p);
  }
  const historicalHTTP = projectWith([
    docBatch("old", "doc", true),
    { ...docBatch("http"), documents: [], requestIds: ["doc"] },
  ]);
  invalid.push(historicalHTTP);
  for (const p of invalid)
    unchangedFailure(p, () => validateAPIResourceTrash(p));
  for (const marker of ["yesterday", "2026-10-31", 1, null]) {
    const p = projectWith([docBatch("a")]);
    p.apiResourceTrash.batches[0].restoredAt = marker;
    unchangedFailure(p, () => validateAPIResourceTrash(p));
  }
});

test("whole-batch conflicts are atomic, including legacy partial HTTP restore and later same-date deletion", () => {
  const variations = [
    [
      "missing HTTP",
      (p) => {
        p.requests = p.requests.filter((x) => x.id !== "http-a");
      },
    ],
    [
      "partial HTTP PUT",
      (p) => {
        delete p.requests[0].deletedAt;
      },
    ],
    [
      "changed deletion date",
      (p) => {
        p.requests[0].deletedAt = "2026-10-29T00:00:00.000Z";
      },
    ],
    [
      "same-date later batch",
      (p) => {
        const b = clone(p.apiResourceTrash.batches[0]);
        b.id += "-later";
        b.documents = [];
        b.selectedTargetIds = ["http-a"];
        p.apiResourceTrash.batches.push(b);
      },
    ],
    [
      "occupied folder",
      (p) => {
        p.folders.push("Parent/A/New");
      },
    ],
    [
      "parent deleted in a later real batch",
      (p) => {
        Object.assign(p, deleteAPIResources(p, ["folder:Parent"]).project);
      },
    ],
    [
      "inactive document snapshot",
      (p) => {
        p.apiResourceTrash.batches[0].documents[0].deletedAt = restoredAt;
      },
    ],
    [
      "settings slot",
      (p) => {
        p.settings.folderServices["Parent/A"] = "other";
      },
    ],
    [
      "protocol",
      (p) => {
        p.protocols = [{ id: "ws", folder: "Parent/A" }];
      },
    ],
    [
      "opaque source",
      (p) => {
        p.settings.apipostProtocolSources = [{ id: "opaque" }];
      },
    ],
    [
      "unknown folder setting",
      (p) => {
        p.settings.folderMystery = { elsewhere: true };
      },
    ],
    [
      "unlocated grpc",
      (p) => {
        p.settings.grpcDefinitions = [{ id: "grpc" }];
      },
    ],
    [
      "native graph",
      (p) => {
        p.settings.nativeInheritance = {};
      },
    ],
    [
      "archived",
      (p) => {
        p.archived = true;
      },
    ],
    [
      "member moved",
      (p) => {
        p.requests[0].folder = "Parent/AB";
      },
    ],
    [
      "folder escapes batch",
      (p) => {
        p.apiResourceTrash.batches[0].folderPaths.push("Elsewhere");
      },
    ],
  ];
  for (const [name, mutate] of variations) {
    const p = deleted();
    mutate(p);
    unchangedFailure(p, () => restore(p), undefined);
  }
  const p = deleted();
  unchangedFailure(p, () => restore(p, "unknown"));
  const restored = restore(p).project;
  unchangedFailure(restored, () => restore(restored));
  const partial = clone(p);
  delete partial.requests[0].deletedAt;
  assert.doesNotThrow(
    () => assertAPIResourceTrashIdentity(p, partial),
    "preserve legacy HTTP PUT restore",
  );
  const reDeleted = deleteAPIResources(partial, ["http-a"]).project;
  assert.doesNotThrow(() => assertAPIResourceTrashIdentity(partial, reDeleted));
  unchangedFailure(reDeleted, () => restore(reDeleted));
});

test("identity checks retain append-only history and require exact authorized restoration", () => {
  const before = deleted(),
    result = restore(before).project;
  const context = {
    batchId: before.apiResourceTrash.batches[0].id,
    restoredAt,
  };
  assert.doesNotThrow(() =>
    assertAPIResourceTrashIdentity(before, result, context),
  );
  for (const mutate of [
    (p) => {
      p.apiResourceTrash.batches[0].restoredAt = restoredAt;
    },
    (p) => {
      p.apiResourceTrash.batches[0].documents[0].content = "tampered";
    },
    (p) => {
      p.apiResourceTrash.batches = [];
    },
    (p) => {
      p.apiResourceTrash.batches.push(docBatch("forged", "new-doc", true));
    },
  ]) {
    const after = clone(before);
    mutate(after);
    unchangedFailure(after, () =>
      assertAPIResourceTrashIdentity(before, after),
    );
  }
  const second = deleteAPIResources(before, ["doc-sibling"]).project;
  assert.doesNotThrow(() => assertAPIResourceTrashIdentity(before, second));
  const reordered = clone(second);
  reordered.apiResourceTrash.batches.reverse();
  unchangedFailure(reordered, () =>
    assertAPIResourceTrashIdentity(second, reordered),
  );
  const changed = clone(result);
  changed.runs[0].frozen.value = "tampered";
  unchangedFailure(changed, () =>
    assertAPIResourceTrashIdentity(before, changed, context),
  );
  const normalized = clone(result);
  normalized.revision = 100;
  normalized.configRevision = 90;
  normalized.requests[0].optionalUndefined = undefined;
  assert.doesNotThrow(() =>
    assertAPIResourceTrashIdentity(before, normalized, context),
  );
});

test("unchanged batch/resource/byte budgets include restoration markers", () => {
  const hundred = projectWith(
    Array.from({ length: 100 }, (_, i) => docBatch("b" + i, "d" + i, true)),
  );
  assert.doesNotThrow(() => validateAPIResourceTrash(hundred));
  const tooMany = clone(hundred);
  tooMany.apiResourceTrash.batches.push(docBatch("overflow", "extra"));
  unchangedFailure(tooMany, () => validateAPIResourceTrash(tooMany));
  const bulk = (name, count) => ({
    ...docBatch(name),
    documents: [],
    selectedTargetIds: [name + "0"],
    requestIds: Array.from({ length: count }, (_, i) => name + i),
  });
  const tenThousand = projectWith([bulk("a", 5000), bulk("b", 5000)]);
  assert.doesNotThrow(() => validateAPIResourceTrash(tenThousand));
  const overflow = clone(tenThousand);
  overflow.apiResourceTrash.batches.push(bulk("c", 1));
  unchangedFailure(overflow, () => validateAPIResourceTrash(overflow));
  const exact = projectWith(
    Array.from({ length: 5 }, (_, i) => docBatch("bytes" + i, "bytes-doc" + i)),
  );
  for (let i = 0; i < 4; i++)
    exact.apiResourceTrash.batches[i].documents[0].content = "x".repeat(
      1024 * 1024 - 1024,
    );
  const last = exact.apiResourceTrash.batches[4].documents[0];
  last.content = "";
  const remaining =
    4 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(exact.apiResourceTrash));
  last.content = "x".repeat(remaining);
  assert.equal(
    Buffer.byteLength(JSON.stringify(exact.apiResourceTrash)),
    4 * 1024 * 1024,
  );
  assert.doesNotThrow(() => validateAPIResourceTrash(exact));
  unchangedFailure(exact, () => restore(exact), /容量|字节|MiB|大小|JSON/);
  const overBytes = clone(exact);
  overBytes.apiResourceTrash.batches[0].restoredAt = restoredAt;
  unchangedFailure(overBytes, () => validateAPIResourceTrash(overBytes));
});

test("first storage/import accepts valid restored history but cannot claim a restore context", () => {
  const imported = restore(deleted()).project;
  const snapshot = clone(imported);
  assert.doesNotThrow(() =>
    assertAPIResourceTrashIdentity(undefined, imported),
  );
  unchangedFailure(
    imported,
    () =>
      assertAPIResourceTrashIdentity(undefined, imported, {
        batchId: imported.apiResourceTrash.batches[0].id,
        restoredAt,
      }),
    /原项目/,
  );
  assert.deepEqual(imported, snapshot);
});

test("ordinary identity never reads unrelated metadata getters while trash stays descriptor-safe", () => {
  const previous = deleted(),
    next = clone(previous);
  let reads = 0;
  for (const project of [previous, next]) {
    for (const key of ["history", "activity"]) {
      Object.defineProperty(project, key, {
        enumerable: true,
        configurable: true,
        get() {
          reads++;
          throw Error("unrelated metadata getter must not run");
        },
      });
    }
  }
  assert.doesNotThrow(() => assertAPIResourceTrashIdentity(previous, next));
  assert.equal(reads, 0);
  const invalid = clone(deleted());
  Object.defineProperty(invalid, "apiResourceTrash", {
    enumerable: true,
    get() {
      reads++;
      throw Error("trash getter must not run");
    },
  });
  assert.throws(
    () => assertAPIResourceTrashIdentity(previous, invalid),
    /访问器/,
  );
  assert.equal(reads, 0);
  assert.equal(
    typeof Object.getOwnPropertyDescriptor(invalid, "apiResourceTrash").get,
    "function",
  );
});

test("explicit restore preserves safe own JSON Schema keyword properties without prototype changes", () => {
  const before = deleted();
  before.requests[0].schema = JSON.parse(
    '{"type":"object","properties":{"constructor":{"type":"string"},"prototype":{"type":"number"},"__proto__":{"type":"boolean"}}}',
  );
  const snapshot = clone(before);
  const result = restore(before).project;
  assert.deepEqual(before, snapshot);
  assert.deepEqual(result.requests[0].schema, before.requests[0].schema);
  assert.equal(
    Object.getPrototypeOf(result.requests[0].schema.properties),
    Object.prototype,
  );
  for (const key of ["constructor", "prototype", "__proto__"])
    assert.equal(
      Object.hasOwn(result.requests[0].schema.properties, key),
      true,
    );
  assert.doesNotThrow(() =>
    assertAPIResourceTrashIdentity(before, result, {
      batchId: before.apiResourceTrash.batches[0].id,
      restoredAt,
    }),
  );
  const invalidTrash = clone(before);
  invalidTrash.apiResourceTrash.batches[0].documents[0].attributes = JSON.parse(
    '{"__proto__":{"polluted":true}}',
  );
  unchangedFailure(invalidTrash, () => restore(invalidTrash), /不安全字段/);
});

function implicitFixture(kind = "mixed") {
  return {
    id: "implicit",
    folders: [],
    settings: {},
    requests:
      kind === "doc"
        ? []
        : [
            {
              id: "only-http",
              method: "GET",
              url: "https://example.invalid",
              folder: "A/B",
            },
          ],
    documents:
      kind === "http"
        ? []
        : [
            {
              id: "only-doc",
              title: "only",
              content: "retained",
              folder: "A/B",
            },
          ],
  };
}

test("last implicit members and nested folder restore without manufacturing explicit declarations", () => {
  for (const kind of ["doc", "http", "mixed"]) {
    const original = implicitFixture(kind),
      snapshot = clone(original);
    const ids = [...original.requests, ...original.documents].map((x) => x.id);
    const removed = deleteAPIResources(original, ids).project;
    assert.deepEqual(original, snapshot);
    assert.deepEqual(removed.apiResourceTrash.batches[0].implicitParents, [
      "A",
      "A/B",
    ]);
    const removedSnapshot = clone(removed),
      restored = restore(removed).project;
    assert.deepEqual(removed, removedSnapshot);
    assert.deepEqual(restored.requests, original.requests);
    assert.deepEqual(restored.documents, original.documents);
    assert.deepEqual(restored.folders, []);
    assert.deepEqual(restored.settings, {});
    const legacy = clone(removed);
    delete legacy.apiResourceTrash.batches[0].implicitParents;
    unchangedFailure(legacy, () => restore(legacy), /原父目录已不存在/);
    const missingAncestor = clone(removed);
    missingAncestor.apiResourceTrash.batches[0].implicitParents = ["A/B"];
    unchangedFailure(
      missingAncestor,
      () => restore(missingAncestor),
      /原父目录已不存在：A/,
    );
  }
  const original = implicitFixture();
  original.folders = ["A/B"];
  const removed = deleteAPIResources(original, ["folder:A/B"]).project;
  assert.deepEqual(removed.apiResourceTrash.batches[0].implicitParents, ["A"]);
  assert.deepEqual(removed.apiResourceTrash.batches[0].folderPaths, ["A/B"]);
  const restored = restore(removed).project;
  assert.deepEqual(
    restored.folders,
    ["A/B"],
    "implicit A must not become explicit",
  );
  assert.deepEqual(restored.settings, {});
  assert.deepEqual(restored.requests, original.requests);
  assert.deepEqual(restored.documents, original.documents);
});

test("later real parent deletion invalidates old implicit evidence until that batch is restored", () => {
  const original = implicitFixture("doc");
  const first = deleteAPIResources(original, ["only-doc"]).project;
  const firstId = first.apiResourceTrash.batches[0].id;
  first.folders.push("A");
  const later = deleteAPIResources(first, ["folder:A"]).project;
  const laterId = later.apiResourceTrash.batches[1].id;
  unchangedFailure(later, () => restore(later, firstId), /原父目录已不存在/);
  const parentRestored = restore(later, laterId).project;
  const resourceRestored = restore(parentRestored, firstId).project;
  assert.deepEqual(resourceRestored.documents, original.documents);
  assert.deepEqual(
    resourceRestored.folders,
    ["A"],
    "only the later explicit A is reintroduced",
  );
  assert.deepEqual(resourceRestored.settings, {});
  assert.equal(resourceRestored.apiResourceTrash.batches.length, 2);
  assert.equal(
    resourceRestored.apiResourceTrash.batches.every(
      (x) => x.restoredAt === restoredAt,
    ),
    true,
  );
});

test("implicit witness codec rejects malformed/duplicate/overlapping paths and consumes original budgets", () => {
  for (const paths of [
    ["A", "A"],
    ["A/../B"],
    [""],
    ["A/__proto__"],
    "A",
    [7],
  ]) {
    const invalid = projectWith([docBatch("witness")]);
    invalid.apiResourceTrash.batches[0].implicitParents = paths;
    unchangedFailure(invalid, () => validateAPIResourceTrash(invalid));
  }
  const overlap = projectWith([docBatch("witness")]);
  overlap.apiResourceTrash.batches[0].folderPaths = ["A"];
  overlap.apiResourceTrash.batches[0].implicitParents = ["A"];
  unchangedFailure(overlap, () => validateAPIResourceTrash(overlap), /重叠/);
  const make = (id, count) => ({
    ...docBatch(id),
    documents: [],
    selectedTargetIds: [id + "0"],
    requestIds: Array.from({ length: count }, (_, i) => id + i),
  });
  const exact = projectWith([make("a", 5000), make("b", 4999)]);
  exact.apiResourceTrash.batches[0].implicitParents = ["A"];
  assert.doesNotThrow(() => validateAPIResourceTrash(exact));
  const overflow = clone(exact);
  overflow.apiResourceTrash.batches[0].implicitParents.push("B");
  unchangedFailure(overflow, () => validateAPIResourceTrash(overflow), /10000/);
  const bytes = projectWith(
    Array.from({ length: 5 }, (_, i) => docBatch("bytes-w" + i, "doc-w" + i)),
  );
  for (let i = 0; i < 4; i++)
    bytes.apiResourceTrash.batches[i].documents[0].content = "x".repeat(
      1024 * 1024 - 1024,
    );
  bytes.apiResourceTrash.batches[4].documents[0].content = "";
  bytes.apiResourceTrash.batches[4].documents[0].content = "x".repeat(
    4 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(bytes.apiResourceTrash)),
  );
  assert.doesNotThrow(() => validateAPIResourceTrash(bytes));
  bytes.apiResourceTrash.batches[0].implicitParents = ["A"];
  unchangedFailure(bytes, () => validateAPIResourceTrash(bytes), /字节限制/);
});
