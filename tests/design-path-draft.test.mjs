import assert from "node:assert/strict";
import test from "node:test";
import {
  createDesignPathDrafts,
  designPathNames,
  designPathTable,
  usesDesignPathDraft,
} from "../public/design-path-draft.js";
import { requestParameterTabs } from "../public/http-request-parameter-tabs.js";
import { serializeRequestPath } from "../src/path-serialization.mjs";
import { exportOpenAPI, normalizeRequest } from "../src/core.mjs";

const absolute = "http://127.0.0.1:38982/verification";
test("recognizes only whole braced path segments; handles duplicates without binding non-path/partial text", () => {
  for (const source of [absolute, "/verification", "{{base}}/verification"]) {
    assert.deepEqual(
      designPathNames(source + "/{one}/{two}/{one}?x={query}#{fragment}"),
      ["one", "two"],
    );
    assert.deepEqual(designPathNames(source + "/{one}/{two}?x={one}"), ["two"]);
    assert.deepEqual(designPathNames(source + "/{one}/{one}.txt"), []);
    assert.deepEqual(
      designPathNames(source + "/:id/{{variable}}/%7Bid%7D/{__proto__}/{open"),
      [],
    );
  }
  assert.deepEqual(designPathNames("http://{authority}/status"), []);
  assert.deepEqual(designPathNames("//example.invalid/{id}"), []);
  assert.deepEqual(designPathNames("ftp://example.invalid/{id}"), []);
});

test("prunes only untouched own rows; never loses authored examples, existing definitions, or loaded rows", () => {
  const owner = { configRevision: 1 };
  const authored = {
    key: "manual",
    value: "0001",
    schema: { type: "string", minLength: 2 },
  };
  const request = { url: "/{manual}/{one}/{two}", path: [authored] };
  const state = createDesignPathDrafts();
  assert.equal(state.sync(owner, request), true);
  assert.equal(state.isLinked(owner, request, authored), false);
  assert.deepEqual(
    request.path.map(({ key }) => key),
    ["manual", "one", "two"],
  );
  const one = request.path[1],
    two = request.path[2];
  one.value = "0007";
  assert.equal(state.isLinked(owner, request, one), true);
  request.url = "/{three}";
  assert.equal(state.sync(owner, request), true);
  assert.equal(request.path.includes(one), true);
  assert.equal(request.path.includes(two), false);
  assert.equal(state.isLinked(owner, request, one), false);
  assert.strictEqual(request.path[0], authored);
  assert.equal(one.value, "0007");
  owner.configRevision++;
  request.url = "/";
  assert.equal(state.sync(owner, request), false);
  assert.deepEqual(
    request.path.map(({ key }) => key),
    ["manual", "one", "three"],
  );
  const other = { ...request, url: "/{id}", path: [] };
  state.sync(owner, other);
  const reloaded = structuredClone(other);
  reloaded.url = "/";
  assert.equal(state.sync(owner, reloaded), false);
  assert.equal(reloaded.path[0].key, "id");
});

test("ownership-only detach repaints the same kept row and cannot relink it on reintroduction", () => {
  const owner = { configRevision: 1 };
  const request = { url: "/{id}/{same}", path: [] };
  const state = createDesignPathDrafts();
  assert.equal(state.isLinked(owner, request, {}), false);
  assert.equal(state.sync(owner, request), true);
  const array = request.path;
  const [edited, unchanged] = array;
  edited.value = "0007";
  request.url = "/:id/{same}/{same}?x={ignored}#fragment";
  assert.equal(state.sync(owner, request), true);
  assert.strictEqual(request.path, array);
  assert.equal(edited.value, "0007");
  assert.equal(state.isLinked(owner, request, edited), false);
  assert.equal(state.isLinked(owner, request, unchanged), true);
  request.url = "/{id}/{same}";
  assert.equal(state.sync(owner, request), false);
  assert.strictEqual(request.path, array);
  assert.equal(state.isLinked(owner, request, edited), false);
});

test("guards compatibility-owned path definitions and exports plain rows using the existing runtime contract", () => {
  const request = normalizeRequest({
    name: "Path fixture",
    url: absolute + "/{id}",
  });
  assert.equal(
    usesDesignPathDraft({ settings: { nativeInheritance: {} } }, request),
    false,
  );
  for (const options of [
    { graphqlEditorVersion: 1 },
    { nativeInheritance: {} },
    { scriptURLRuntime: {} },
    { scriptURLMode: "sdk" },
    { path: [{ key: "id", pathSerialization: { version: 1 } }] },
  ]) {
    assert.equal(usesDesignPathDraft({}, { ...request, ...options }), false);
  }
  const owner = { name: "Path fixture", requests: [request] };
  createDesignPathDrafts().sync(owner, request);
  request.path[0].value = "0007";
  assert.equal(serializeRequestPath(request), absolute + "/0007");
  assert.deepEqual(
    exportOpenAPI(owner).paths["/verification/{id}"].get.parameters,
    [
      {
        name: "id",
        in: "path",
        required: true,
        description: "",
        schema: { type: "string" },
        example: "0007",
      },
    ],
  );
});

test("Debug Path displays the same real row metadata and counts named rows only in the ordinary projection", () => {
  const request = {
    url: "/{id}",
    path: [{ key: "", value: "manual" }],
    bodyType: "none",
  };
  const owner = { configRevision: 1 };
  const drafts = createDesignPathDrafts();
  drafts.sync(owner, request);
  const render = (debug) =>
    designPathTable(
      request.path,
      (row) => drafts.isLinked(owner, request, row),
      String,
      { debug },
    );
  assert.match(render(true), /debug-path-pairs/);
  assert.match(render(true), /data-pair="path:1:key"[^>]*readonly/);
  assert.match(render(true), /role="img" aria-label="必填"[^>]*>\*/);
  assert.match(render(true), /data-remove-pair="path:0"/);
  assert.doesNotMatch(render(true), /data-remove-pair="path:1"/);
  assert.doesNotMatch(render(false), /debug-path-/);
  assert.match(
    requestParameterTabs(request, "path", true),
    />Path \(1\)<\/button>/,
  );
  assert.match(requestParameterTabs(request, "path"), />Path \(2\)<\/button>/);
});
