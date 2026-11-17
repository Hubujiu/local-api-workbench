import { createCollectionAPI } from "../src/postman-collection-runtime.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  preparePostmanCollection,
  collectionExecutionScopes,
  createCollectionSession,
  validateCollectionScope,
} from "../src/postman-collection-scopes.mjs";
import {
  createScopes,
  effectiveScopes,
  projectScopes,
  scopeChanges,
  persistScopeChanges,
  scopedExecution,
} from "../src/variable-scopes.mjs";
import { debugEnvironment } from "../src/environments.mjs";
import {
  publishDebugVariables,
  clearDebugVariables,
} from "../src/debug-publication.mjs";
const fixture = () => ({
  id: "project",
  configRevision: 1,
  globalVariables: { x: "global", g: "global-only" },
  environments: [{ id: "env", name: "env", variables: { x: "environment" } }],
  requests: [],
  plans: [],
  cases: [],
  postmanCollections: {
    version: 1,
    items: ["a", "b"].map((id) =>
      preparePostmanCollection(
        {
          info: { name: id },
          item: [],
          variable: [
            { key: "x", value: id },
            { key: "only", value: id },
            { key: "nil", value: null },
          ],
        },
        () => id,
      ),
    ),
  },
});
test("collection scope order and A/B/A selection preserve separate runtime and committed collection layers", () => {
  const p = fixture(),
    session = createCollectionSession(collectionExecutionScopes(p));
  const a = createScopes(
    {},
    {
      ...projectScopes(p, "env"),
      ...session.select("a"),
      runtime: { x: "runtime" },
    },
  );
  assert.equal(effectiveScopes(a).x, "runtime");
  delete a.runtime.x;
  assert.equal(effectiveScopes(a).x, "environment");
  delete a.environment.x;
  assert.equal(effectiveScopes(a).x, "a");
  delete a.collection.x;
  delete a.collectionTypes.x;
  assert.equal(effectiveScopes(a).x, "global");
  a.collection.only = "a-updated";
  session.accept(a);
  const b = session.select("b");
  assert.equal(b.collection.only, "b");
  b.collection.only = "private-copy";
  assert.equal(session.select("b").collection.only, "b");
  assert.equal(session.select("a").collection.only, "a-updated");
  assert.equal(p.postmanCollections.items[0].variables.only, "a");
  assert.deepEqual(session.select(undefined), {});
});
test("host collection identity and scope types reject forged targets before persistence", async () => {
  const p = fixture(),
    before = projectScopes(p, "env", undefined, "a"),
    after = structuredClone(before);
  after.collectionId = "b";
  assert.throws(() => scopeChanges(before, after), /宿主固定/);
  assert.throws(
    () => validateCollectionScope({ ...before, collectionTypes: {} }, "a"),
    /不匹配/,
  );
  const changed = structuredClone(before);
  changed.collection.only = "changed";
  const changes = scopeChanges(before, changed);
  let saved = 0;
  await assert.rejects(
    persistScopeChanges(
      { get: async () => structuredClone(p), save: async () => saved++ },
      p.id,
      "env",
      changes,
      { collectionId: "b" },
    ),
    /提交身份/,
  );
  assert.equal(saved, 0);
});
test("collection stage commits use exact signal, preserve null definitions and reject same-field conflicts", async () => {
  let p = fixture();
  const controller = new AbortController();
  let saves = 0;
  const store = {
    get: async () => structuredClone(p),
    save: async (next, options) => {
      assert.equal(options.signal, controller.signal);
      p = structuredClone(next);
      saves++;
    },
  };
  const before = projectScopes(p, "env", undefined, "a"),
    after = structuredClone(before);
  after.collection.only = "new";
  after.collection.nil = false;
  await persistScopeChanges(store, p.id, "env", scopeChanges(before, after), {
    signal: controller.signal,
    collectionId: "a",
  });
  assert.equal(saves, 1);
  assert.equal(p.postmanCollections.items[0].variables.only, "new");
  assert.equal(
    p.postmanCollections.items[0].definitions.nil.initialValue,
    null,
  );
  assert.equal(p.postmanCollections.items[1].variables.only, "b");
  await assert.rejects(
    persistScopeChanges(store, p.id, "env", scopeChanges(before, after), {
      collectionId: "a",
    }),
    /变量冲突/,
  );
  assert.equal(saves, 1);
  controller.abort();
  await assert.rejects(
    persistScopeChanges(store, p.id, "env", [], {
      signal: controller.signal,
      collectionId: "a",
    }),
    /取消/,
  );
  assert.equal(saves, 1);
});
test("collection debug entries isolate A/B while retaining clear CAS and environment defaults", () => {
  const p = fixture(),
    cache = new Map();
  const a = debugEnvironment(p, "env", cache, "a"),
    b = debugEnvironment(p, "env", cache, "b"),
    legacy = debugEnvironment(p, "env", cache);
  assert.notEqual(a.cacheKey, b.cacheKey);
  assert.notEqual(a.cacheKey, legacy.cacheKey);
  assert.equal(a.variables.only, "a");
  assert.equal(b.variables.only, "b");
  assert.equal(legacy.variables.only, undefined);
  assert.equal(
    publishDebugVariables(cache, a.publication, {
      fingerprint: a.fingerprint,
      variables: { only: "override-a" },
    }),
    true,
  );
  assert.equal(debugEnvironment(p, "env", cache, "b").variables.only, "b");
  const stale = debugEnvironment(p, "env", cache, "b");
  clearDebugVariables(cache, p.id);
  assert.equal(
    publishDebugVariables(cache, stale.publication, {
      variables: { only: "stale" },
    }),
    false,
  );
  const shadowed = debugEnvironment(p, "env", cache, "a").fingerprint;
  p.postmanCollections.items[0].variables.x = "changed-under-environment";
  assert.notEqual(debugEnvironment(p, "env", cache, "a").fingerprint, shadowed);
  const old = debugEnvironment(p, "env", cache, "a").fingerprint;
  p.postmanCollections.items[0].variables.only = "edit";
  assert.notEqual(debugEnvironment(p, "env", cache, "a").fingerprint, old);
});
test("scoped execution publishes collection-aware receipts without sharing project registry objects", async () => {
  const p = fixture();
  let disk = structuredClone(p);
  const store = {
    get: async () => structuredClone(disk),
    save: async (next) => {
      disk = structuredClone(next);
    },
  };
  const execution = scopedExecution(store, p, "env");
  const before = projectScopes(p, "env", undefined, "a"),
    after = structuredClone(before);
  after.collection.only = "saved";
  await execution.onScopeChanges(scopeChanges(before, after), undefined, "a");
  assert.equal(execution.receipt().commits, 1);
  assert.deepEqual(
    execution.receipt().changes.map((x) => [x.scope, x.collectionId, x.name]),
    [["collection", "a", "only"]],
  );
  assert.equal(execution.collectionScopes[0].collection.only, "a");
  assert.equal(disk.postmanCollections.items[0].variables.only, "saved");
});

test("collection facade copies reads, preserves falsy values and treats unset/clear then set as new any", () => {
  const state = {
    collectionId: "a",
    collection: { obj: { a: [0] }, typed: 0, nil: null },
    collectionTypes: { obj: "any", typed: "number", nil: "any" },
  };
  let refresh = 0;
  const api = createCollectionAPI(state, () => refresh++);
  api.get("obj").a.push(2);
  api.toObject().obj.a.push(3);
  assert.deepEqual(api.get("obj"), { a: [0] });
  assert.equal(api.has("nil"), true);
  assert.equal(api.get("nil"), null);
  api.set("typed", "2");
  assert.equal(api.get("typed"), 2);
  assert.throws(() => api.set("typed", "bad"), /有限/);
  assert.equal(api.get("typed"), 2);
  api.unset("typed");
  api.set("typed", "text");
  assert.equal(api.get("typed"), "text");
  assert.equal(state.collectionTypes.typed, "any");
  api.set("nil", false);
  assert.equal(api.get("nil"), false);
  api.clear();
  assert.deepEqual(api.toObject(), {});
  assert.deepEqual(state.collectionTypes, {});
  const empty = createCollectionAPI({}, () => {
    throw Error("must not refresh");
  });
  assert.equal(empty.get("x"), undefined);
  assert.equal(empty.has("x"), false);
  for (const mutate of [
    () => empty.set("x", 1),
    () => empty.unset("x"),
    () => empty.clear(),
  ])
    assert.throws(mutate, /未绑定/);
  assert.ok(refresh >= 5);
});
