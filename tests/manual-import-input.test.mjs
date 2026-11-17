import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeManualImportInput,
  normalizeManualImportApply,
  assertManualImportResult,
} from "../src/manual-import-input.mjs";

const input = () => ({
  format: "apipost",
  document: { apis: [] },
  selection: { mode: "all" },
});

test("manual import input is explicit and leaves its caller's data unchanged", () => {
  const raw = input(),
    before = structuredClone(raw);
  const value = normalizeManualImportInput(raw);
  assert.deepEqual(raw, before);
  assert.deepEqual(value.policies, {
    api: "both",
    samples: "both",
    models: "both",
    environments: "both",
    documents: "both",
    globals: "safe",
  });
  assert.deepEqual(
    normalizeManualImportInput({
      ...raw,
      selection: { mode: "explicit", keys: [] },
    }).selection.keys,
    [],
  );
  assert.notEqual(value.document, raw.document);
});

test("unsupported or implicit modes, invalid selection and unknown authorization fields reject", () => {
  for (const change of [
    (x) => delete x.selection,
    (x) => {
      x.selection = [];
    },
    (x) => {
      x.selection = { mode: "all", keys: [] };
    },
    (x) => {
      x.selection = { mode: "explicit", keys: ["a", "a"] };
    },
    (x) => {
      x.selection = { mode: "explicit", keys: ["a"], exclude: ["a"] };
    },
    (x) => {
      x.format = "json5";
    },
    (x) => {
      x.sessionId = "chosen";
    },
    (x) => {
      x.options = { inheritanceMode: "preserve" };
    },
    (x) => {
      x.policies = { models: "clear" };
    },
    (x) => {
      x.policies = { models: "ignore" };
    },
    (x) => {
      x.policies = { environments: "name" };
    },
    (x) => {
      x.options = { sync: true };
    },
    (x) => {
      x.folderMap = { a: "../outside" };
    },
    (x) => {
      x.bindings = { a: "" };
    },
    (x) => {
      x.clearScope = { folder: "" };
    },
    (x) => {
      x.policies = { api: "clear" };
    },
    (x) => {
      x.policies = { api: "clear" };
      x.clearScope = { folder: "" };
      x.selection = { mode: "explicit", keys: [] };
    },
  ]) {
    const value = input();
    change(value);
    assert.throws(() => normalizeManualImportInput(value), {
      code: "MANUAL_IMPORT_INPUT_INVALID",
    });
  }
});

test("descriptor and proxy attacks are rejected before any field access", () => {
  let reads = 0;
  const getter = Object.defineProperty(input(), "document", {
    enumerable: true,
    get() {
      reads++;
      return {};
    },
  });
  const proxy = new Proxy(
    {},
    {
      get() {
        reads++;
      },
      ownKeys() {
        reads++;
        return [];
      },
      getPrototypeOf() {
        reads++;
        return Object.prototype;
      },
    },
  );
  assert.throws(() => normalizeManualImportInput(getter));
  assert.throws(() => normalizeManualImportInput(proxy));
  assert.equal(reads, 0);
});

test("explicit null is not omission or permission to select a default mode", () => {
  for (const key of ["policies", "folderMap", "bindings", "options"])
    assert.throws(() =>
      normalizeManualImportInput({ ...input(), [key]: null }),
    );
  assert.throws(() =>
    normalizeManualImportInput({ ...input(), policies: { api: null } }),
  );
  assert.throws(() =>
    normalizeManualImportInput({
      ...input(),
      selection: { mode: "explicit", keys: [], exclude: null },
    }),
  );
});

test("apply envelope cannot supply trusted context or candidate output and result bounds do not truncate", () => {
  assert.deepEqual(
    normalizeManualImportApply({ token: "token", input: input() }).input
      .selection,
    { mode: "all" },
  );
  for (const extra of [
    "projectId",
    "sessionId",
    "context",
    "candidate",
    "planDigest",
  ])
    assert.throws(() =>
      normalizeManualImportApply({
        token: "token",
        input: input(),
        [extra]: "forged",
      }),
    );
  assert.throws(() =>
    normalizeManualImportApply({ token: "x".repeat(4097), input: input() }),
  );
  assert.throws(() =>
    assertManualImportResult({ value: "x".repeat(2 * 1024 * 1024) }),
  );
  assert.deepEqual(assertManualImportResult({ noOp: true }), { noOp: true });
});
