import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import {
  assertOpenAPISubsetPlan,
  openAPISelectionScope,
  scopedOpenAPIInput,
} from "../public/openapi-file-selection.js";
import { assertOpenAPIReview } from "../public/openapi-file-review.js";

const doc = {
  openapi: "3.0.3",
  info: { title: "Local selection fixture", version: "1" },
  paths: {
    "/z-last": {
      get: { summary: "Z getter", responses: { 200: { description: "OK" } } },
    },
    "/a-first": {
      get: { summary: "A getter", responses: { 200: { description: "OK" } } },
    },
  },
};

test("selection projects labels only from the proven direct GET inventory", () => {
  const items = [
    { key: "api:requests/0", kind: "api", dependencies: [] },
    { key: "api:requests/1", kind: "api", dependencies: [] },
  ];
  const preview = { sourceDigest: "fixture", items };
  const scope = openAPISelectionScope(JSON.stringify(doc), preview);
  assert.equal(scope.labels.get("api:requests/0").label, "A getter");
  assert.equal(scope.labels.get("api:requests/1").label, "Z getter");
  assert.equal(
    openAPISelectionScope(JSON.stringify(doc), {
      ...preview,
      items: [items[0]],
    }),
    null,
  );
  for (const replacement of [
    { post: doc.paths["/a-first"].get },
    { $ref: "#/paths/~1z-last" },
  ]) {
    assert.equal(
      openAPISelectionScope(
        JSON.stringify({
          ...doc,
          paths: { ...doc.paths, "/a-first": replacement },
        }),
        preview,
      ),
      null,
    );
  }
});

test("actual owner preview accepts a frozen subset token, not the older all token", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openapi-subset-owner-test-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const owner = await app.store.create("Synthetic");
  const baseline = await app.store.get(owner.id);
  const launch = new URL(app.launchUrl);
  const token =
    new URLSearchParams(launch.hash.slice(1)).get("token") || app.token;
  const call = async (action, body) => {
    const response = await fetch(
      launch.origin + "/api/projects/" + owner.id + "/" + action,
      {
        method: "POST",
        headers: { "x-local-token": token, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return { status: response.status, result: await response.json() };
  };
  const complex = structuredClone(doc);
  complex.paths["/a-first"].get.responses["200"].content = {
    "application/json": { schema: { $ref: "#/components/schemas/Recursive" } },
  };
  complex.components = {
    schemas: {
      Recursive: {
        type: "object",
        properties: {
          next: { $ref: "#/components/schemas/Recursive" },
          shared: { $ref: "#/components/schemas/Shared" },
        },
      },
      Shared: { type: "string" },
      Unused: { type: "integer" },
    },
  };
  const input = Object.freeze({
    format: "openapi",
    document: JSON.stringify(complex),
    selection: Object.freeze({ mode: "all" }),
  });
  const all = await call("import-preview", input);
  assert.equal(all.status, 200);
  assert(assertOpenAPIReview(all.result, baseline.configRevision));
  const scope = openAPISelectionScope(input.document, all.result);
  const keys = ["api:requests/0"];
  const subset = scopedOpenAPIInput(input, keys);
  const changed = await call("import-preview", subset);
  assert.equal(changed.status, 200);
  const excluded = assertOpenAPISubsetPlan(scope, keys, changed.result);
  assert.deepEqual([...excluded].sort(), [
    "api:requests/1",
    "model:components/Unused",
  ]);
  assert(
    assertOpenAPIReview(changed.result, baseline.configRevision, excluded),
  );
  assert.equal(
    assertOpenAPIReview(changed.result, baseline.configRevision),
    false,
  );
  const corrupt = structuredClone(changed.result);
  corrupt.items.find(({ key }) => key === keys[0]).action = "update";
  assert.throws(
    () => assertOpenAPISubsetPlan(scope, keys, corrupt),
    /回执不一致/,
  );
  const wrongSkip = structuredClone(changed.result);
  wrongSkip.items.find(({ key }) => key === "api:requests/1").reason =
    "skipped_other";
  assert.throws(
    () => assertOpenAPISubsetPlan(scope, keys, wrongSkip),
    /回执不一致/,
  );
  const missing = structuredClone(changed.result);
  missing.items.shift();
  assert.throws(
    () => assertOpenAPISubsetPlan(scope, keys, missing),
    /回执不一致/,
  );
  assert.throws(
    () =>
      assertOpenAPISubsetPlan(scope, keys, {
        ...changed.result,
        sourceDigest: "wrong",
      }),
    /回执不一致/,
  );
  const old = await call("import-apply", {
    input: subset,
    token: all.result.token,
  });
  assert.notEqual(old.status, 200);
  assert.deepEqual(await app.store.get(owner.id), baseline);

  const applied = await call("import-apply", {
    input: subset,
    token: changed.result.token,
  });
  assert.equal(applied.status, 200);
  const persisted = await app.store.get(owner.id);
  assert.equal(persisted.configRevision, baseline.configRevision + 1);
  assert.deepEqual(
    persisted.requests.map(({ name }) => name),
    ["A getter"],
  );
  const schemas = Object.values(persisted.openapiComponents.schemas);
  assert.deepEqual(schemas.map(({ type }) => type).sort(), [
    "object",
    "string",
  ]);
  const second = await call("import-apply", {
    input: subset,
    token: changed.result.token,
  });
  assert.notEqual(second.status, 200);
  assert.deepEqual(await app.store.get(owner.id), persisted);
});
