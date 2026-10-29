import test from "node:test";
import assert from "node:assert/strict";
import { persistScopeChanges } from "../src/variable-scopes.mjs";
test("scope persistence cancellation rejects after an awaited read before saving", async () => {
  const controller = new AbortController();
  let saves = 0;
  await assert.rejects(
    persistScopeChanges(
      {
        get: async () => {
          controller.abort();
          return {
            id: "p",
            environments: [{ id: "e", name: "env", variables: {} }],
          };
        },
        save: async () => {
          saves++;
        },
      },
      "p",
      "e",
      [],
      { signal: controller.signal },
    ),
    /取消/,
  );
  assert.equal(saves, 0);
});
test("scope persistence cancellation does not retry an earlier conflicting save", async () => {
  const controller = new AbortController();
  let reads = 0,
    saves = 0;
  await assert.rejects(
    persistScopeChanges(
      {
        get: async () => {
          reads++;
          return {
            id: "p",
            environments: [{ id: "e", name: "env", variables: {} }],
          };
        },
        save: async () => {
          saves++;
          controller.abort();
          throw Error("项目已被其他窗口修改");
        },
      },
      "p",
      "e",
      [],
      { signal: controller.signal },
    ),
    /取消/,
  );
  assert.equal(reads, 1);
  assert.equal(saves, 1);
});

const changes = [
  {
    scope: "environment",
    name: "value",
    before: { exists: true, value: "old" },
    after: { exists: true, value: "new" },
  },
];
const project = () => ({
  id: "p",
  globalVariables: {},
  environments: [{ id: "e", name: "env", variables: { value: "old" } }],
});
test("scope persistence forwards the exact signal through a blocked save and cannot acknowledge a rejected admission", async () => {
  const controller = new AbortController();
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let writes = 0,
    saves = 0,
    options;
  const pending = persistScopeChanges(
    {
      get: async () => project(),
      save: async (_p, o) => {
        saves++;
        options = o;
        entered.resolve();
        await release.promise;
        if (o?.signal?.aborted)
          throw Object.assign(Error("项目保存已取消"), {
            code: "STORE_SAVE_ABORTED",
          });
        writes++;
      },
    },
    "p",
    "e",
    changes,
    { signal: controller.signal },
  );
  const rejected = assert.rejects(pending, { code: "STORE_SAVE_ABORTED" });
  await entered.promise;
  assert.equal(options.signal, controller.signal);
  controller.abort();
  release.resolve();
  await rejected;
  assert.equal(saves, 1);
  assert.equal(writes, 0);
});
test("scope persistence preserves a confirmed save even when cancellation arrives before acknowledgment returns", async () => {
  const controller = new AbortController();
  let saved;
  const result = await persistScopeChanges(
    {
      get: async () => project(),
      save: async (p, o) => {
        assert.equal(o.signal, controller.signal);
        saved = structuredClone(p);
        controller.abort();
      },
    },
    "p",
    "e",
    changes,
    { signal: controller.signal },
  );
  assert.equal(controller.signal.aborted, true);
  assert.equal(result.scopes.environment.value, "new");
  assert.equal(saved.environments[0].variables.value, "new");
});
test("scope persistence never translates or retries a late storage error as cancellation", async () => {
  const controller = new AbortController(),
    error = Object.assign(Error("fixture storage acknowledgment unknown"), {
      code: "FIXTURE_UNKNOWN",
    });
  let saves = 0;
  await assert.rejects(
    persistScopeChanges(
      {
        get: async () => project(),
        save: async (_p, o) => {
          assert.equal(o.signal, controller.signal);
          saves++;
          controller.abort();
          throw error;
        },
      },
      "p",
      "e",
      changes,
      { signal: controller.signal },
    ),
    (e) => e === error,
  );
  assert.equal(saves, 1);
});
