import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportOpenAPI, normalizeRequest } from "../src/core.mjs";
import { Store } from "../src/runtime.mjs";
import { appendRequestQuery } from "../src/query-serialization.mjs";
import { designPairComposer } from "../public/design-pair-composer.js";
import {
  changedProvisionalQuery,
  createProvisionalQuery,
  provisionalQueryDefaults,
  provisionalQueryNotice,
  provisionalQueryRow,
} from "../public/design-query-provisional.js";

test("provisional selection is scoped to one empty request object and fails stale updates closed", () => {
  const control = createProvisionalQuery();
  const project = { id: "owner" },
    sameIdOtherProject = { id: "owner" };
  const request = { id: "r", query: [] },
    sameIdOtherRequest = { id: "r", query: [] };
  const edited = { type: "integer", enabled: false, required: true };
  control.observe(project, request);
  const initial = control.read(project, request);
  assert.deepEqual(initial, provisionalQueryDefaults);
  assert.ok(!changedProvisionalQuery(initial));
  assert.ok(
    !control.update(project, request, initial, { ...edited, type: "object" }),
  );
  assert.equal(control.update(project, request, initial, edited), true);
  assert.ok(
    !control.update(project, request, initial, provisionalQueryDefaults),
  );
  assert.ok(changedProvisionalQuery(control.read(project, request)));
  assert.equal(provisionalQueryRow("  ", control.read(project, request)), null);
  assert.deepEqual(request.query, []);
  control.observe(project, request);
  assert.deepEqual(control.read(project, request), edited);
  control.observe(sameIdOtherProject, sameIdOtherRequest);
  assert.equal(control.read(project, request), undefined);
  assert.deepEqual(
    control.read(sameIdOtherProject, sameIdOtherRequest),
    provisionalQueryDefaults,
  );
  control.observe(project, request);
  assert.deepEqual(control.read(project, request), provisionalQueryDefaults);
  assert.equal(control.update(project, request, initial, edited), false);
  control.observe(project, null);
  assert.equal(control.read(project, request), undefined);
});

test("only true empty Query gains independent controls, not unnamed persisted fields or fake type options", () => {
  const defaults = provisionalQueryDefaults;
  assert.deepEqual(provisionalQueryRow("alpha", defaults), {
    key: "alpha",
    value: "",
    enabled: true,
  });
  const body = designPairComposer("query", true, defaults);
  for (const control of [
    "draft-type",
    "draft-required",
    "draft-enabled",
    "add-pair",
  ])
    assert.match(body, new RegExp("data-(?:design-query-)?" + control));
  assert.doesNotMatch(body, /data-pair=|data-design-query-type=/);
  assert.doesNotMatch(
    designPairComposer("headers", true, defaults),
    /data-design-query-draft/,
  );
  assert.doesNotMatch(
    designPairComposer("query", false, defaults),
    /data-design-query-draft/,
  );
  assert.equal(provisionalQueryNotice(defaults), "");
  assert.match(
    provisionalQueryNotice({ ...defaults, required: true }),
    /填写参数名后才能保存/,
  );
});

test("a named provisional scalar round-trips through local project persistence and OpenAPI without wire coercion", async () => {
  const root = await mkdtemp(join(tmpdir(), "query-provisional-"));
  try {
    const store = new Store(root);
    const project = await store.create("synthetic query");
    const query = createProvisionalQuery();
    const request = normalizeRequest({
      id: "request",
      name: "one",
      url: "http://127.0.0.1:1/sample",
    });
    query.observe(project, request);
    const chosen = { type: "integer", required: true, enabled: false };
    assert.equal(
      query.update(project, request, query.read(project, request), chosen),
      true,
    );
    const pending = query.read(project, request);
    assert.deepEqual(request.query, []);
    assert.deepEqual((await store.get(project.id)).requests, []);
    const row = provisionalQueryRow("field", pending);
    row.value = "001";
    assert.equal(appendRequestQuery(new URL(request.url), [row]).search, "");
    request.query.push(row);
    request.query.push({ ...row, key: "enabledField", enabled: true });
    query.observe(project, request);
    assert.equal(query.read(project, request), undefined);
    project.requests.push(request);
    await store.save(project);
    const reopened = await new Store(root).get(project.id);
    assert.deepEqual(reopened.requests[0].query, [
      {
        key: "field",
        value: "001",
        schema: { type: "integer" },
        required: true,
        enabled: false,
      },
      {
        key: "enabledField",
        value: "001",
        schema: { type: "integer" },
        required: true,
        enabled: true,
      },
    ]);
    assert.equal(
      appendRequestQuery(new URL(request.url), reopened.requests[0].query)
        .search,
      "?enabledField=001",
    );
    assert.deepEqual(exportOpenAPI(reopened).paths["/sample"].get.parameters, [
      {
        name: "enabledField",
        in: "query",
        required: true,
        description: "",
        schema: { type: "integer" },
        example: "001",
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
