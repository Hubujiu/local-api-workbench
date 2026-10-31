import test from "node:test";
import assert from "node:assert/strict";
import { importIntoProject } from "../src/core.mjs";
import { freezeServiceBinding } from "../src/environments.mjs";
import {
  assertNativeInheritanceIdentity,
  editNativeInheritance,
  resolveNativeInheritance,
  validateNativeInheritanceProject,
} from "../src/native-inheritance.mjs";
import {
  deleteAPIResources,
  validateAPIResourceTrash,
} from "../src/api-resource-lifecycle.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import { nativeInheritanceFixture } from "./fixtures/native-inheritance.mjs";

// Model-only acceptance: no server, sockets, SDK, original runtime or execution.
// The native-format fixture is independently authored, not a vendor export.
const DATE = "2026-10-31T12:00:00.000Z";
const LATER = "2026-10-31T13:00:00.000Z";
const context = (batchId = "fixture-id", deletedAt = DATE) => ({
  batchId,
  deletedAt,
});
const graph = (p) => p.settings.nativeInheritance;
const request = (p, sourceId = "api") =>
  p.requests.find((r) => r.nativeInheritance.sourceId === sourceId);
const recycle = (p, sourceId = "folder", ctx = context()) =>
  editNativeInheritance(p, { type: "recycle-folder", sourceId }, ctx);
const restore = (p, batchId = "fixture-id") =>
  editNativeInheritance(p, { type: "restore-folder", batchId });
const sorted = (values) => [...values].sort();
function fixture() {
  const source = nativeInheritanceFixture();
  const folder = source.apis[0];
  folder.name = "A";
  folder.parent_id = "ancestor";
  source.apis[1].parent_id = "child";
  for (const [id, parent, name] of [
    ["ancestor", "0", "Ancestor"],
    ["child", "folder", "Child"],
    ["sibling", "ancestor", "AB"],
    ["empty", "0", "Empty"],
  ])
    source.apis.push({
      target_id: id,
      target_type: "folder",
      parent_id: parent,
      name,
      request: { auth: { type: "inherit" } },
    });
  source.apis.push({
    ...structuredClone(source.apis[1]),
    target_id: "sibling-api",
    parent_id: "sibling",
    name: "Sibling",
  });
  const sourceBefore = structuredClone(source);
  const project = {
    id: "model-target",
    name: "model target",
    requests: [],
    folders: [],
    environments: [],
    servers: [],
    globalVariables: {},
    settings: {},
    plans: [],
    cases: [],
    documents: [],
    history: [],
    runs: [],
  };
  importIntoProject(project, source, { inheritanceMode: "preserve" });
  assert.deepEqual(
    source,
    sourceBefore,
    "import cannot mutate the source object",
  );
  validateNativeInheritanceProject(project);
  return { project, source, sourceBefore };
}
function rejectsAtomically(project, action, label) {
  const before = structuredClone(project);
  assert.throws(() => action(project), undefined, label);
  assert.deepEqual(project, before, label + ": input must be unchanged");
}

test("folder model: complete subtree uses the existing codec and preserves graph/source/frozen evidence", () => {
  const { project: p, source, sourceBefore } = fixture();
  const frozen = freezeServiceBinding(p, request(p));
  p.cases = [
    {
      id: "case",
      sourceRequestId: request(p).id,
      request: structuredClone(frozen),
    },
  ];
  p.plans = [{ id: "plan", steps: [{ request: structuredClone(frozen) }] }];
  p.history = [{ id: "history", request: structuredClone(frozen) }];
  p.runs = [{ id: "run", status: "passed" }];
  const before = structuredClone(p);
  assert.equal(Object.hasOwn(graph(p), "folderLifecycle"), false);
  const next = recycle(p);
  const codec = deleteAPIResources(p, ["folder:Ancestor/A"], context()).project;
  assert.deepEqual(next.apiResourceTrash, codec.apiResourceTrash);
  assert.deepEqual(next.requests, codec.requests);
  assert.deepEqual(next.folders, codec.folders);
  assert.deepEqual(graph(next).folderLifecycle, {
    version: 1,
    records: [{ sourceId: "folder", batchId: "fixture-id", state: "recycled" }],
  });
  assert.deepEqual(graph(next).folders, graph(p).folders);
  assert.deepEqual(graph(next).bindings, graph(p).bindings);
  assert.deepEqual(graph(next).projectLayer, graph(p).projectLayer);
  assert.deepEqual(
    sorted(validateNativeInheritanceProject(next).inactiveFolders),
    ["child", "folder"],
  );
  assert.deepEqual(sorted(next.folders), ["Ancestor", "Ancestor/AB", "Empty"]);
  assert.equal(request(next).deletedAt, DATE);
  assert.deepEqual(request(next, "sibling-api"), request(p, "sibling-api"));
  assert.deepEqual(next.apiResourceTrash.batches[0].selectedTargetIds, [
    "folder:Ancestor/A",
  ]);
  assert.deepEqual(sorted(next.apiResourceTrash.batches[0].explicitFolders), [
    "Ancestor/A",
    "Ancestor/A/Child",
  ]);
  for (const key of ["cases", "plans", "history", "runs"])
    assert.deepEqual(next[key], before[key]);
  assert.deepEqual(resolveNativeInheritance(next, frozen), frozen);
  assert.throws(() => resolveNativeInheritance(next, request(p)));
  const forged = structuredClone(frozen);
  forged.url += "/forged";
  assert.throws(() => resolveNativeInheritance(next, forged));
  assertNativeInheritanceIdentity(
    p,
    next,
    { type: "recycle-folder", sourceId: "folder" },
    context(),
  );
  assert.deepEqual(p, before);
  assert.deepEqual(source, sourceBefore);
});

test("folder model: restore whole batch, active edits/moves and repeat recycle retain immutable history", () => {
  const { project: p } = fixture();
  const recycled = recycle(p);
  const trash = structuredClone(recycled.apiResourceTrash);
  const restored = restore(recycled);
  assert.deepEqual(sorted(restored.folders), sorted(p.folders));
  assert.deepEqual(restored.requests, p.requests);
  assert.deepEqual(restored.apiResourceTrash, trash);
  assert.equal(graph(restored).folderLifecycle.records[0].state, "restored");
  assert.equal(
    validateNativeInheritanceProject(restored).inactiveFolders.size,
    0,
  );
  assertNativeInheritanceIdentity(recycled, restored, {
    type: "restore-folder",
    batchId: "fixture-id",
  });
  rejectsAtomically(
    restored,
    (q) => restore(q),
    "restored batch cannot restore twice",
  );
  let moved = editNativeInheritance(restored, {
    type: "move-folder",
    sourceId: "folder",
    parentId: "0",
    name: "Moved",
  });
  assert.deepEqual(moved.apiResourceTrash, trash);
  const values = structuredClone(moved);
  request(values).url = "/edited";
  graph(values).folders.find(
    (f) => f.sourceId === "folder",
  ).layer.headers[0].value = "edited";
  assertNativeInheritanceIdentity(moved, values);
  moved = values;
  const again = recycle(moved, "folder", context("second-batch", LATER));
  assert.deepEqual(again.apiResourceTrash.batches[0], trash.batches[0]);
  assert.equal(again.apiResourceTrash.batches.length, 2);
  assert.deepEqual(graph(again).folderLifecycle.records, [
    { sourceId: "folder", batchId: "fixture-id", state: "restored" },
    { sourceId: "folder", batchId: "second-batch", state: "recycled" },
  ]);
  assert.deepEqual(again.apiResourceTrash.batches[1].selectedTargetIds, [
    "folder:Moved",
  ]);
  assert.equal(request(again).deletedAt, LATER);
  rejectsAtomically(
    again,
    (q) => restore(q),
    "old batch cannot restore newer lifecycle",
  );
  assert.deepEqual(restore(again, "second-batch").requests, moved.requests);
});

test("folder model: empty folders recycle/restore with history and both definition exports refuse", () => {
  const { project: p } = fixture();
  const next = recycle(p, "empty");
  assert.deepEqual(next.requests, p.requests);
  assert.deepEqual(next.apiResourceTrash.batches[0].requestIds, []);
  assert.deepEqual(next.apiResourceTrash.batches[0].folderPaths, ["Empty"]);
  assert.deepEqual(
    sorted(validateNativeInheritanceProject(next).inactiveFolders),
    ["empty"],
  );
  const restored = restore(next);
  assert.deepEqual(sorted(restored.folders), sorted(p.folders));
  for (const q of [next, restored])
    for (const encode of [exportApipost, exportApipostDirectory]) {
      rejectsAtomically(
        q,
        (value) => encode(value),
        "native export cannot drop lifecycle history",
      );
    }
});

test("folder model: reject partial restoration and moves crossing inactive boundaries, allow disjoint sibling", () => {
  const { project: p } = fixture();
  const next = recycle(p);
  for (const operation of [
    { type: "restore-requests", requestIds: [request(next).id] },
    { type: "move-request", requestId: request(next).id, parentId: "sibling" },
    {
      type: "move-request",
      requestId: request(next, "sibling-api").id,
      parentId: "child",
    },
    { type: "move-folder", sourceId: "folder", parentId: "0", name: "Moved" },
    { type: "move-folder", sourceId: "child", parentId: "0", name: "Moved" },
    { type: "move-folder", sourceId: "ancestor", parentId: "0", name: "Moved" },
    {
      type: "move-folder",
      sourceId: "sibling",
      parentId: "folder",
      name: "Moved",
    },
  ])
    rejectsAtomically(
      next,
      (q) => editNativeInheritance(q, operation),
      JSON.stringify(operation),
    );
  const moved = editNativeInheritance(next, {
    type: "move-folder",
    sourceId: "sibling",
    parentId: "0",
    name: "Disjoint",
  });
  assert.equal(request(moved, "sibling-api").folder, "Disjoint");
  assert.deepEqual(moved.apiResourceTrash, next.apiResourceTrash);
  assert.deepEqual(graph(moved).folderLifecycle, graph(next).folderLifecycle);
  assert.equal(request(restore(moved)).folder, "Ancestor/A/Child");
});

test("folder model: ordinary saves cannot alter lifecycle, linked batches or inactive definitions", () => {
  const { project: p } = fixture();
  const next = recycle(p);
  for (const mutate of [
    (q) => {
      delete graph(q).folderLifecycle;
    },
    (q) => {
      graph(q).folderLifecycle.records = [];
    },
    (q) => {
      graph(q).folderLifecycle.records[0].state = "restored";
    },
    (q) => {
      q.apiResourceTrash.batches[0].deletedAt = LATER;
      request(q).deletedAt = LATER;
    },
    (q) => {
      q.apiResourceTrash.batches[0].id = "replacement";
      graph(q).folderLifecycle.records[0].batchId = "replacement";
    },
    (q) => {
      delete request(q).deletedAt;
    },
    (q) => {
      request(q).url = "/tampered";
    },
    (q) => {
      request(q).headers.push({ key: "X-Tamper", value: "yes", enabled: true });
    },
    (q) => {
      graph(q).folders.find(
        (f) => f.sourceId === "folder",
      ).layer.headers[0].value = "tampered";
    },
    (q) => {
      graph(q)
        .folders.find((f) => f.sourceId === "child")
        .layer.query.push({ key: "tamper", value: "yes", enabled: true });
    },
  ]) {
    const changed = structuredClone(next);
    mutate(changed);
    rejectsAtomically(
      next,
      (q) => assertNativeInheritanceIdentity(q, changed),
      "ordinary save tamper",
    );
  }
  const edited = structuredClone(next);
  graph(edited)
    .folders.find((f) => f.sourceId === "ancestor")
    .layer.headers.push({ key: "X-Ancestor", value: "new", enabled: true });
  request(edited, "sibling-api").url = "/active-edit";
  assertNativeInheritanceIdentity(next, edited);
  const restored = restore(edited);
  assert(
    resolveNativeInheritance(restored, request(restored)).headers.some(
      (h) => h.key === "X-Ancestor" && h.value === "new",
    ),
  );
  const tamperedHistory = structuredClone(restored);
  graph(tamperedHistory).folderLifecycle.records = [];
  assert.throws(() =>
    assertNativeInheritanceIdentity(restored, tamperedHistory),
  );
  const changedBatch = structuredClone(restored);
  changedBatch.apiResourceTrash.batches[0].deletedAt = LATER;
  assert.throws(() => assertNativeInheritanceIdentity(restored, changedBatch));
});

const malformed = [
  [
    "marker version",
    (q) => {
      graph(q).folderLifecycle.version = 2;
    },
  ],
  [
    "marker unknown field",
    (q) => {
      graph(q).folderLifecycle.extra = true;
    },
  ],
  [
    "records type",
    (q) => {
      graph(q).folderLifecycle.records = {};
    },
  ],
  [
    "unknown state",
    (q) => {
      graph(q).folderLifecycle.records[0].state = "deleted";
    },
  ],
  [
    "record extra field",
    (q) => {
      graph(q).folderLifecycle.records[0].skip = true;
    },
  ],
  [
    "missing source",
    (q) => {
      graph(q).folderLifecycle.records[0].sourceId = "missing";
    },
  ],
  [
    "HTTP source is not folder",
    (q) => {
      graph(q).folderLifecycle.records[0].sourceId = "api";
    },
  ],
  [
    "missing batch",
    (q) => {
      graph(q).folderLifecycle.records[0].batchId = "missing";
    },
  ],
  [
    "duplicate active record",
    (q) => {
      graph(q).folderLifecycle.records.push(
        structuredClone(graph(q).folderLifecycle.records[0]),
      );
    },
  ],
  [
    "overlapping root",
    (q) => {
      graph(q).folderLifecycle.records.push({
        sourceId: "child",
        batchId: "child-batch",
        state: "recycled",
      });
      const b = structuredClone(q.apiResourceTrash.batches[0]);
      b.id = "child-batch";
      b.selectedTargetIds = ["folder:Ancestor/A/Child"];
      b.folderPaths = b.explicitFolders = ["Ancestor/A/Child"];
      q.apiResourceTrash.batches.push(b);
    },
  ],
  [
    "noncanonical date",
    (q) => {
      q.apiResourceTrash.batches[0].deletedAt = "2026-10-31";
    },
  ],
  [
    "mismatched date",
    (q) => {
      q.apiResourceTrash.batches[0].deletedAt = LATER;
    },
  ],
  [
    "missing HTTP tombstone",
    (q) => {
      delete request(q).deletedAt;
    },
  ],
  [
    "extra selection",
    (q) => {
      q.apiResourceTrash.batches[0].selectedTargetIds.push(request(q).id);
    },
  ],
  [
    "HTTP-only selection",
    (q) => {
      q.apiResourceTrash.batches[0].selectedTargetIds = [request(q).id];
    },
  ],
  [
    "wrong root selection",
    (q) => {
      q.apiResourceTrash.batches[0].selectedTargetIds = [
        "folder:Ancestor/A/Child",
      ];
    },
  ],
  [
    "missing subtree path",
    (q) => {
      q.apiResourceTrash.batches[0].folderPaths = ["Ancestor/A"];
      q.apiResourceTrash.batches[0].explicitFolders = ["Ancestor/A"];
    },
  ],
  [
    "missing explicit folder",
    (q) => {
      q.apiResourceTrash.batches[0].explicitFolders = [];
    },
  ],
  [
    "missing HTTP membership",
    (q) => {
      q.apiResourceTrash.batches[0].requestIds = [];
    },
  ],
  [
    "foreign HTTP membership",
    (q) => {
      q.apiResourceTrash.batches[0].requestIds.push("foreign-api");
    },
  ],
  [
    "sibling HTTP membership",
    (q) => {
      q.apiResourceTrash.batches[0].requestIds.push(
        request(q, "sibling-api").id,
      );
    },
  ],
  [
    "document in batch",
    (q) => {
      q.apiResourceTrash.batches[0].documents.push({
        id: "doc",
        title: "doc",
        content: "",
        folder: "Ancestor/A",
      });
    },
  ],
  [
    "folder settings in batch",
    (q) => {
      q.apiResourceTrash.batches[0].folderSettings.folderServices = {
        "Ancestor/A": "service",
      };
    },
  ],
  [
    "inactive path leaked",
    (q) => {
      q.folders.push("Ancestor/A");
    },
  ],
  [
    "active path missing",
    (q) => {
      q.folders = q.folders.filter((x) => x !== "Ancestor/AB");
    },
  ],
  [
    "source project mismatch",
    (q) => {
      request(q).nativeInheritance.sourceProjectId = "foreign";
    },
  ],
  [
    "graph binding removed",
    (q) => {
      graph(q).bindings.shift();
    },
  ],
  [
    "graph folder removed",
    (q) => {
      graph(q).folders = graph(q).folders.filter((f) => f.sourceId !== "child");
    },
  ],
  [
    "live binding in frozen case",
    (q) => {
      q.cases = [
        {
          sourceRequestId: request(q).id,
          request: structuredClone(request(q)),
        },
      ];
    },
  ],
];
for (const [label, mutate] of malformed)
  test(`folder model validation: ${label}`, () => {
    const q = recycle(fixture().project);
    mutate(q);
    rejectsAtomically(q, validateNativeInheritanceProject, label);
  });

test("folder model: scope/operation/context refusals remain atomic", () => {
  const { project: p } = fixture();
  for (const operation of [
    { type: "recycle-folder", sourceId: "missing" },
    { type: "recycle-folder", sourceId: "api" },
    { type: "recycle-folder", sourceId: "0" },
    { type: "recycle-folder", sourceId: "folder", batchId: "client-batch" },
    { type: "recycle-folder", sourceId: "folder", deletedAt: DATE },
    { type: "recycle-folder", sourceId: "folder", requestIds: [request(p).id] },
    { type: "restore-folder", batchId: "missing" },
  ])
    rejectsAtomically(
      p,
      (q) => editNativeInheritance(q, operation, context()),
      "invalid operation",
    );
  for (const ctx of [
    {},
    { batchId: "id" },
    { deletedAt: DATE },
    context("", DATE),
    context("id", "2026-10-31"),
    context("id", "invalid"),
  ])
    rejectsAtomically(
      p,
      (q) => recycle(q, "folder", ctx),
      "invalid backend context",
    );
  const pending = recycle(p, "child");
  rejectsAtomically(
    pending,
    (q) => recycle(q, "folder", context("parent")),
    "overlapping ancestor",
  );
  rejectsAtomically(
    pending,
    (q) => recycle(q, "child", context("child-again")),
    "already inactive",
  );
  rejectsAtomically(
    pending,
    (q) =>
      editNativeInheritance(q, {
        type: "restore-folder",
        batchId: "fixture-id",
        sourceId: "child",
      }),
    "restore extra field",
  );
  for (const mutate of [
    (q) => {
      request(q).deletedAt = DATE;
    },
    (q) => {
      q.documents = [
        { id: "doc", title: "doc", content: "", folder: "Ancestor/A/Child" },
      ];
    },
    (q) => {
      q.documents = [
        {
          id: "doc",
          title: "doc",
          content: "",
          folder: "Ancestor/A",
          deletedAt: DATE,
        },
      ];
    },
    (q) => {
      q.protocols = [{ id: "ws", folder: "Ancestor/A/Child" }];
    },
    (q) => {
      q.settings.apipostProtocolSources = [{ target_id: "connection" }];
    },
    (q) => {
      q.settings.grpcDefinitions = [{ id: "grpc" }];
    },
    (q) => {
      q.settings.socketioDefinitions = [{ id: "socket", folder: "Ancestor/A" }];
    },
    (q) => {
      q.settings.folderUnknown = { "Ancestor/A": true };
    },
    (q) => {
      q.documents = [
        {
          id: request(q).id,
          title: "collision",
          content: "",
          folder: "Ancestor/AB",
        },
      ];
    },
  ]) {
    const q = structuredClone(p);
    mutate(q);
    rejectsAtomically(q, recycle, "unsupported subtree or ambiguous resource");
  }
});

test("folder model: existing HTTP-only recycle/restore remains independent", () => {
  const { project: p } = fixture();
  const ids = [request(p).id];
  const next = editNativeInheritance(
    p,
    { type: "recycle-requests", requestIds: ids },
    context(),
  );
  assert.deepEqual(graph(next), graph(p));
  assert.deepEqual(next.folders, p.folders);
  assert.equal(next.apiResourceTrash, undefined);
  assert.deepEqual(
    editNativeInheritance(next, { type: "restore-requests", requestIds: ids })
      .requests,
    p.requests,
  );
  const native = editNativeInheritance(
    p,
    { type: "recycle-requests", requestIds: ids },
    { ...context(), nativeTrash: true },
  );
  assert.deepEqual(native.apiResourceTrash.batches[0].selectedTargetIds, ids);
  assert.deepEqual(graph(native), graph(p));
  assert.deepEqual(
    editNativeInheritance(native, { type: "restore-requests", requestIds: ids })
      .apiResourceTrash,
    native.apiResourceTrash,
  );
});

test("folder model: 100-batch and 10000-resource budgets fail without changing input", () => {
  const { project: p } = fixture();
  const historical = deleteAPIResources(
    p,
    [request(p, "sibling-api").id],
    context("history"),
  ).project.apiResourceTrash.batches[0];
  const full = structuredClone(p);
  full.apiResourceTrash = {
    version: 1,
    batches: Array.from({ length: 100 }, (_, i) => ({
      ...structuredClone(historical),
      id: `history-${i}`,
    })),
  };
  validateAPIResourceTrash(full);
  rejectsAtomically(full, recycle, "100-batch budget");
  const resources = structuredClone(p);
  const paths = Array.from({ length: 5000 }, (_, i) => `Historical-${i}`);
  resources.apiResourceTrash = {
    version: 1,
    batches: [0, 1].map((i) => ({
      id: `resources-${i}`,
      deletedAt: DATE,
      selectedTargetIds: ["folder:Historical-0"],
      folderPaths: [...paths],
      explicitFolders: [],
      requestIds: [],
      documents: [],
      folderSettings: {},
    })),
  };
  validateAPIResourceTrash(resources);
  rejectsAtomically(resources, recycle, "10000-resource budget");
  const duplicate = recycle(p);
  const restored = restore(duplicate);
  rejectsAtomically(
    restored,
    recycle,
    "batch IDs cannot be reused after restoration",
  );
});

test("folder model: 4 MiB trash and 256 KiB graph budgets also apply to generated lifecycle metadata", () => {
  const { project: p } = fixture();
  const fullTrash = structuredClone(p);
  fullTrash.apiResourceTrash = {
    version: 1,
    batches: [
      {
        id: "large-history",
        deletedAt: DATE,
        selectedTargetIds: ["historical-doc-0"],
        folderPaths: [],
        explicitFolders: [],
        requestIds: [],
        folderSettings: {},
        documents: Array.from({ length: 4 }, (_, i) => ({
          id: `historical-doc-${i}`,
          title: "history",
          content: "x".repeat(1024 * 1024),
        })),
      },
    ],
  };
  const trashLimit = 4 * 1024 * 1024;
  const excess =
    Buffer.byteLength(JSON.stringify(fullTrash.apiResourceTrash)) -
    (trashLimit - 64);
  fullTrash.apiResourceTrash.batches[0].documents[3].content = "x".repeat(
    1024 * 1024 - excess,
  );
  validateAPIResourceTrash(fullTrash);
  validateNativeInheritanceProject(fullTrash);
  rejectsAtomically(
    fullTrash,
    recycle,
    "generated batch must fit the unchanged 4 MiB trash budget",
  );
  const fullGraph = structuredClone(p);
  const row = graph(fullGraph).projectLayer.headers[0];
  row.description = "";
  row.description = "x".repeat(
    262144 - 32 - Buffer.byteLength(JSON.stringify(graph(fullGraph))),
  );
  validateNativeInheritanceProject(fullGraph);
  rejectsAtomically(
    fullGraph,
    recycle,
    "generated lifecycle must fit the unchanged 256 KiB graph budget",
  );
});

test("folder model: inactive graph still obeys folder/binding/depth constraints and operation identity protects snapshots", () => {
  const p = recycle(fixture().project);
  for (const mutate of [
    (q) => {
      graph(q).folders = Array.from({ length: 101 }, () =>
        structuredClone(graph(q).folders[0]),
      );
    },
    (q) => {
      graph(q).bindings = Array.from({ length: 1001 }, () =>
        structuredClone(graph(q).bindings[0]),
      );
    },
    (q) => {
      let path = "";
      for (let i = 0; i < 31; i++) {
        path += (path ? "/" : "") + "D";
        graph(q).folders.push({
          sourceId: `deep-${i}`,
          parentId: i ? `deep-${i - 1}` : "0",
          name: "D",
          path,
          layer: {
            auth: { mode: "inherit" },
            headers: [],
            query: [],
            cookies: [],
            form: [],
          },
        });
        q.folders.push(path);
      }
    },
  ]) {
    const q = structuredClone(p);
    mutate(q);
    rejectsAtomically(
      q,
      validateNativeInheritanceProject,
      "graph budget remains enforced",
    );
  }
  const { project: active } = fixture();
  const frozen = freezeServiceBinding(active, request(active));
  active.cases = [
    { id: "saved-case", sourceRequestId: request(active).id, request: frozen },
  ];
  active.plans = [
    { id: "saved-plan", steps: [{ request: structuredClone(frozen) }] },
  ];
  const next = recycle(active);
  for (const key of ["cases", "plans"]) {
    const q = structuredClone(next);
    q[key] = [];
    assert.throws(() =>
      assertNativeInheritanceIdentity(
        active,
        q,
        { type: "recycle-folder", sourceId: "folder" },
        context(),
      ),
    );
  }
  const staleContext = context("different-batch", LATER);
  assert.throws(() =>
    assertNativeInheritanceIdentity(
      active,
      next,
      { type: "recycle-folder", sourceId: "folder" },
      staleContext,
    ),
  );
});
