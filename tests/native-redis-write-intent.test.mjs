import test from "node:test";
import assert from "node:assert/strict";
import {
  importedRedisSet,
  normalizeNativeRedisSetQuery,
  nativeWriteDigest,
  collectNativeRedisWrites,
  denyNativeWrites,
} from "../src/native-redis-write-intent.mjs";
import {
  databaseWriteReceipt,
  validateDatabaseWriteReceipts,
} from "../src/database-write-receipts.mjs";

test("native SET imported exact key/value is inert canonical intent", () => {
  assert.equal(importedRedisSet({ key: "k", value: "" }), '["SET","k",""]');
  assert.equal(
    normalizeNativeRedisSetQuery('["SET", "键", "值"]'),
    '["SET","键","值"]',
  );
  for (const input of [
    { key: "k", value: "v", NX: true },
    { key: "k" },
    { key: 1, value: "v" },
    { key: "", value: "v" },
    { key: "k", value: "{{x}}" },
    { key: "k", value: "\ud800" },
    { key: "k", value: "v".repeat(4097) },
  ])
    assert.throws(() => importedRedisSet(input));
  for (const input of [
    '["SET","k","v","NX"]',
    '["get","k","v"]',
    '["SET","k",1]',
    "{}",
    "null",
  ])
    assert.throws(() => normalizeNativeRedisSetQuery(input));
});
test("intent identity stable and ordinals include disabled and script tasks", () => {
  assert.equal(
    nativeWriteDigest({ b: 2, a: 1 }),
    nativeWriteDigest({ a: 1, b: 2 }),
  );
  assert.notEqual(
    nativeWriteDigest(["SET", "a", "b"]),
    nativeWriteDigest(["SET", "b", "a"]),
  );
  const task = {
    type: "database",
    enabled: 1,
    id: "task",
    data: {
      writeIntent: "redis-set",
      connectionId: "source",
      query: '["SET","k","v"]',
    },
  };
  const request = {
    nativeTasks: {
      before: [
        { type: "customScript", enabled: 1, data: "" },
        { ...task, enabled: 0 },
        task,
      ],
      after: [],
    },
  };
  const [write] = collectNativeRedisWrites(request);
  assert.equal(write.ordinal, 2);
  assert.equal(write.phase, "before");
  assert.equal(write.taskId, "task");
  assert.throws(() => denyNativeWrites([{}, request]), {
    code: "NATIVE_WRITE_AUTHORITY_REQUIRED",
  });
  assert.doesNotThrow(() =>
    denyNativeWrites([
      { nativeTasks: { before: [{ ...task, enabled: 0 }], after: [] } },
    ]),
  );
});
const identity = {
  runId: "run",
  preparationId: "prep",
  projectId: "project",
  receiptId: "receipt",
  connectionId: "source",
  phase: "before",
  ordinal: 2,
  commandDigest: "a".repeat(64),
};
test("receipt explicit projection immutable and secret free", () => {
  const receipt = databaseWriteReceipt(
    { ...identity, password: "secret", query: "secret", error: "secret" },
    "unknown",
    "transport",
  );
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(JSON.stringify(receipt).includes("secret"), false);
  assert.deepEqual(validateDatabaseWriteReceipts([receipt]), [receipt]);
  for (const extra of [{ password: "secret" }, { version: 2 }])
    assert.throws(() =>
      validateDatabaseWriteReceipts([{ ...receipt, ...extra }]),
    );
  assert.throws(() =>
    databaseWriteReceipt(identity, "not-sent", "acknowledged"),
  );
  assert.throws(() =>
    databaseWriteReceipt(identity, "acknowledged-applied", "transport"),
  );
  assert.throws(() =>
    databaseWriteReceipt(identity, "unknown", "raw Redis error"),
  );
  assert.throws(() => validateDatabaseWriteReceipts([receipt, receipt]));
});
