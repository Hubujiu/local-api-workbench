import test from "node:test";
import assert from "node:assert/strict";
import { buildManualImportPlan } from "../src/manual-import-planner.mjs";
import { buildManualImportSourceGraph } from "../src/manual-import-source.mjs";
import { manualImportCanonicalFixture } from "./fixtures/manual-import-source.mjs";
import { restoreAPIResources } from "../src/api-resource-restore.mjs";

const context = {
  nonce: Buffer.alloc(32, 9).toString("base64url"),
  issuedAt: 1_700_000_000_000,
  expiresAt: 1_700_000_060_000,
};
const target = () => ({
  id: "target",
  name: "Target",
  requests: [],
  documents: [],
  folders: [],
  cases: [],
  plans: [],
  environments: [],
  settings: {},
  history: [],
  runs: [],
});
const input = (extra = {}) => ({
  format: "auto",
  document: {},
  selection: { mode: "all" },
  ...extra,
});
const graph = () =>
  buildManualImportSourceGraph(manualImportCanonicalFixture(), context);
const firstKey = (g, kind) => g.nodes.find((node) => node.kind === kind).key;

test("pure plan imports all typed resources with final sample/model/environment and registry references", () => {
  const p = target(),
    g = graph(),
    before = structuredClone(p);
  const result = buildManualImportPlan(p, g, input(), context);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(p, before);
  assert.equal(result.project.requests.length, 1);
  assert.equal(
    result.project.cases[0].sourceRequestId,
    result.project.requests[0].id,
  );
  assert.equal(
    result.project.caseFolders[1].parentId,
    result.project.caseFolders[0].id,
  );
  assert.equal(result.project.dictionary.length, 2);
  assert.equal(
    result.project.requests[0].schema.$ref,
    `#/components/schemas/${result.project.dictionary[0].id}`,
  );
  assert.equal(
    result.project.cases[0].request.schema.$ref,
    `#/components/schemas/${result.project.dictionary[1].id}`,
  );
  assert.equal(
    result.project.plans[0].environmentId,
    result.project.environments[0].id,
  );
  assert.equal(
    result.project.requests[0].postmanCollectionId,
    result.project.postmanCollections.items[0].id,
  );
  assert.equal(result.project.globalVariables.shared, "value");
  assert.ok(result.project.protocols.length);
  assert.ok(result.project.settings.apipostDirectoryArtifacts.length);
  assert.equal(result.noOp, false);
  assert.deepEqual(buildManualImportPlan(p, g, input(), context), result);
});

test("explicit sample-only selection closes its API, groups, model cycles and configuration dependencies", () => {
  const g = graph(),
    chosen = firstKey(g, "case");
  const result = buildManualImportPlan(
    target(),
    g,
    input({ selection: { mode: "explicit", keys: [chosen] } }),
    context,
  );
  assert.deepEqual(result.blockers, []);
  assert.equal(result.project.requests.length, 1);
  assert.equal(result.project.cases.length, 1);
  assert.equal(result.project.dictionary.length, 2);
  assert.equal(result.project.documents.length, 0);
  assert.equal(result.project.plans.length, 0);
  assert.equal(
    result.items.find((item) => item.kind === "document").reason,
    "not_selected",
  );
  assert.throws(
    () =>
      buildManualImportPlan(
        target(),
        g,
        input({
          selection: {
            mode: "explicit",
            keys: [chosen],
            exclude: [firstKey(g, "api")],
          },
        }),
        context,
      ),
    { code: "MANUAL_IMPORT_DEPENDENCY_EXCLUDED" },
  );
});

test("explicit empty is no-op and both folders never silently merge into an existing path", () => {
  const p = target(),
    g = graph();
  p.folders = ["Root"];
  const empty = buildManualImportPlan(
    p,
    g,
    input({ selection: { mode: "explicit", keys: [] } }),
    context,
  );
  assert.equal(empty.noOp, true);
  assert.deepEqual(empty.project, p);
  const blocked = buildManualImportPlan(p, g, input(), context);
  assert.ok(
    blocked.blockers.some(
      (item) => item.code === "both_folder_requires_new_path",
    ),
  );
  assert.deepEqual(blocked.project, p);
  const relocated = buildManualImportPlan(
    p,
    g,
    input({ folderMap: { Root: "Imported" } }),
    context,
  );
  assert.deepEqual(relocated.blockers, []);
  assert.equal(relocated.project.requests[0].folder, "Imported/Child");
  assert.ok(relocated.project.folders.includes("Imported"));
});

function apiGraph(two = false) {
  return buildManualImportSourceGraph(
    {
      requests: [
        {
          id: "source",
          name: "New",
          method: "GET",
          url: "https://example.invalid/a?x=1",
          folder: "A",
        },
        ...(two
          ? [
              {
                id: "source2",
                name: "New2",
                method: "GET",
                url: "https://example.invalid/a?x=1",
                folder: "B",
              },
            ]
          : []),
      ],
      folders: two ? ["A", "B"] : ["A"],
      environments: [],
    },
    context,
  );
}

test("API modes use exact keys, ignore drops unused dependencies, and ambiguous or double claims block", () => {
  const p = target();
  p.requests = [
    {
      id: "old",
      name: "Old",
      method: "GET",
      url: "https://example.invalid/a?x=1",
      folder: "A",
    },
    {
      id: "other",
      name: "Other",
      method: "GET",
      url: "https://example.invalid/a?x=1",
      folder: "B",
    },
  ];
  const g = apiGraph();
  const url = buildManualImportPlan(
    p,
    g,
    input({ policies: { api: "url" } }),
    context,
  );
  assert.ok(url.blockers.some((item) => item.code === "ambiguous_api_match"));
  const folder = buildManualImportPlan(
    p,
    g,
    input({ policies: { api: "url_and_folder" } }),
    context,
  );
  assert.deepEqual(folder.blockers, []);
  assert.equal(folder.project.requests[0].id, "old");
  assert.equal(folder.project.requests[0].name, "New");
  assert.deepEqual(folder.project.requests[1], p.requests[1]);
  const one = target();
  one.requests = [p.requests[0]];
  const ignored = buildManualImportPlan(
    one,
    g,
    input({
      policies: { api: "ignore" },
      selection: { mode: "explicit", keys: [firstKey(g, "api")] },
    }),
    context,
  );
  assert.equal(ignored.noOp, true);
  assert.deepEqual(ignored.project, one);
  assert.equal(
    ignored.items.find((item) => item.kind === "folder").reason,
    "unused_dependency",
  );
  const duplicate = buildManualImportPlan(
    one,
    apiGraph(true),
    input({ policies: { api: "url" } }),
    context,
  );
  assert.ok(
    duplicate.blockers.some(
      (item) => item.code === "multiple_sources_one_target",
    ),
  );
  assert.deepEqual(duplicate.project, one);
});

test("safe globals conflict atomically instead of overwriting existing variables or dropping source metadata", () => {
  const p = target();
  p.globalVariables = { shared: "old" };
  const result = buildManualImportPlan(p, graph(), input(), context);
  assert.ok(result.blockers.some((item) => item.code === "resource_conflict"));
  assert.deepEqual(result.project, p);
  const equal = target();
  equal.globalVariables = { shared: "value", local: "retained" };
  const merged = buildManualImportPlan(equal, graph(), input(), context);
  assert.deepEqual(merged.blockers, []);
  assert.deepEqual(merged.project.globalVariables, {
    shared: "value",
    local: "retained",
  });
});

test("clear recycles scoped leaf IDs, preserves shells and evidence, then restores alongside the new definitions", () => {
  const p = target();
  p.requests = [
    {
      id: "old",
      name: "Old",
      method: "GET",
      url: "https://example.invalid/old",
      folder: "A",
    },
    {
      id: "sibling",
      name: "Sibling",
      method: "GET",
      url: "https://example.invalid/sibling",
      folder: "AA",
    },
  ];
  p.cases = [
    {
      id: "old-case",
      name: "Frozen",
      sourceRequestId: "old",
      request: { id: "frozen", url: "old" },
    },
  ];
  p.history = [{ id: "evidence", status: "passed" }];
  const result = buildManualImportPlan(
    p,
    apiGraph(),
    input({ policies: { api: "clear" }, clearScope: { folder: "A" } }),
    context,
  );
  assert.deepEqual(result.blockers, []);
  assert.ok(
    result.project.requests.find((item) => item.id === "old").deletedAt,
  );
  assert.deepEqual(
    result.project.requests.find((item) => item.id === "sibling"),
    p.requests[1],
  );
  assert.deepEqual(result.project.cases, p.cases);
  assert.deepEqual(result.project.history, p.history);
  assert.ok(result.project.folders.includes("A"));
  const batch = result.project.apiResourceTrash.batches[0];
  assert.deepEqual(batch.selectedTargetIds, ["old"]);
  const restored = restoreAPIResources(result.project, batch.id, {
    restoredAt: "2026-01-01T00:00:00.000Z",
  }).project;
  assert.equal(restored.requests.filter((item) => !item.deletedAt).length, 3);
  const outside = buildManualImportPlan(
    p,
    apiGraph(true),
    input({ policies: { api: "clear" }, clearScope: { folder: "A" } }),
    context,
  );
  assert.ok(
    outside.blockers.some((item) => item.code === "outside_clear_scope"),
  );
  assert.deepEqual(outside.project, p);
});

test("model name overwrite blocks unselected live consumers rather than silently changing their schema", () => {
  const p = target();
  p.dictionary = [
    { id: "existing-model", name: "A", schema: { type: "string" } },
  ];
  p.openapiComponents = { schemas: { "existing-model": { type: "string" } } };
  const result = buildManualImportPlan(
    p,
    graph(),
    input({ policies: { models: "name" } }),
    context,
    {
      modelReferences: [
        { modelId: "existing-model", ownerKind: "api", ownerId: "unselected" },
      ],
    },
  );
  assert.ok(
    result.blockers.some((item) => item.code === "unselected_model_consumer"),
  );
  assert.deepEqual(result.project, p);
});

test("non-schema component references stay complete and require their globals bundle", () => {
  const source = manualImportCanonicalFixture();
  source.openapiComponents.parameters = {
    P: { name: "p", in: "query", schema: { type: "string" } },
  };
  source.requests[0].openapiOperation = {
    parameters: [{ $ref: "#/components/parameters/P" }],
  };
  const g = buildManualImportSourceGraph(source, context);
  const result = buildManualImportPlan(target(), g, input(), context);
  assert.deepEqual(result.blockers, []);
  assert.equal(
    result.project.requests[0].openapiOperation.parameters[0].$ref,
    "#/components/parameters/P",
  );
  assert.ok(result.project.openapiComponents.parameters.P);
});

test("model overwrite automatically scans live reverse consumers without caller-provided evidence", () => {
  const p = target();
  p.dictionary = [
    { id: "existing-model", name: "A", schema: { type: "string" } },
  ];
  p.openapiComponents = { schemas: { "existing-model": { type: "string" } } };
  p.requests = [
    {
      id: "unselected",
      method: "GET",
      url: "https://other.invalid",
      schema: { $ref: "#/components/schemas/existing-model" },
    },
  ];
  const result = buildManualImportPlan(
    p,
    graph(),
    input({ policies: { models: "name" } }),
    context,
  );
  assert.ok(
    result.blockers.some((item) => item.code === "unselected_model_consumer"),
  );
  assert.deepEqual(result.project, p);
});

test("explicit sample dependency binding reuses its existing ancestor folder without changing the API", () => {
  const g = graph(),
    p = target(),
    api = firstKey(g, "api"),
    sample = firstKey(g, "case");
  p.folders = ["Root", "Root/Child"];
  p.requests = [
    {
      id: "existing-api",
      name: "untouched",
      method: "POST",
      url: "https://existing.invalid",
      folder: "Root/Child",
    },
  ];
  const result = buildManualImportPlan(
    p,
    g,
    input({
      selection: { mode: "explicit", keys: [sample] },
      bindings: { [api]: "existing-api" },
    }),
    context,
  );
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.project.requests, p.requests);
  assert.equal(result.project.cases[0].sourceRequestId, "existing-api");
});

test("global values and component records are atomic, not recursively merged complementary data", () => {
  for (const values of [
    [{ a: 1 }, { b: 2 }],
    [[1], [2]],
  ]) {
    const p = target();
    p.globalVariables = { shared: values[0] };
    const source = manualImportCanonicalFixture();
    source.globalVariables.shared = values[1];
    const result = buildManualImportPlan(
      p,
      buildManualImportSourceGraph(source, context),
      input(),
      context,
    );
    assert.ok(result.blockers.some((x) => x.code === "resource_conflict"));
    assert.deepEqual(result.project, p);
  }
  const p = target();
  p.openapiComponents = {
    parameters: { P: { name: "p", in: "query", description: "old" } },
  };
  const source = manualImportCanonicalFixture();
  source.openapiComponents.parameters = {
    P: { name: "p", in: "query", required: true },
  };
  const result = buildManualImportPlan(
    p,
    buildManualImportSourceGraph(source, context),
    input(),
    context,
  );
  assert.ok(result.blockers.some((x) => x.code === "resource_conflict"));
  assert.deepEqual(result.project, p);
  const q = target();
  q.globalVariables = { old: { a: 1 } };
  const positive = buildManualImportPlan(q, graph(), input(), context);
  assert.deepEqual(positive.blockers, []);
  assert.deepEqual(positive.project.globalVariables.old, { a: 1 });
  assert.equal(positive.project.globalVariables.shared, "value");
});

test("selective import rejects live plans but permits unrelated API selection", () => {
  const source = manualImportCanonicalFixture();
  source.plans[0].steps[0].liveRequestId = "generated-api";
  const g = buildManualImportSourceGraph(source, context);
  const planKey = firstKey(g, "plan-bundle");
  const apiKey = firstKey(g, "api");
  const selectedPlan = buildManualImportPlan(
    target(),
    g,
    input({ selection: { mode: "explicit", keys: [planKey] } }),
    context,
  );
  assert(
    selectedPlan.blockers.some(
      (item) => item.code === "live_plan_import_unsupported",
    ),
  );
  const selectedAPI = buildManualImportPlan(
    target(),
    g,
    input({ selection: { mode: "explicit", keys: [apiKey] } }),
    context,
  );
  assert.deepEqual(selectedAPI.blockers, []);
  assert.equal(selectedAPI.project.plans.length, 0);
});
