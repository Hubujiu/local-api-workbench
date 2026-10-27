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
