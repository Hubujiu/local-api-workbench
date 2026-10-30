import test from "node:test";
import assert from "node:assert/strict";
import {
  linearPlanStepIds,
  allocateLinearPlanStepIds,
  ownStepProvenance,
} from "../src/plan-step-identities.mjs";

// Pure identity contracts only. No application, network, VM or database imports.
test("linear identity validation covers all explicit and disabled identities before allocation", () => {
  const input = [{}, { id: "dup" }, { id: "dup", enabled: false }];
  const before = structuredClone(input);
  let calls = 0;
  assert.throws(
    () =>
      allocateLinearPlanStepIds(input, () => {
        calls++;
        return "new";
      }),
    /步骤ID/,
  );
  assert.equal(calls, 0);
  assert.deepEqual(input, before);
  for (const value of [
    null,
    false,
    0,
    1,
    [],
    {},
    "__proto__",
    "constructor",
    "prototype",
    "x".repeat(201),
    "\ud800",
  ])
    assert.throws(
      () => linearPlanStepIds([{ id: value, enabled: false }]),
      /步骤ID/,
    );
});

test("only missing or empty IDs allocate once while valid opaque identities remain unchanged", () => {
  const input = [
    { id: "fixed" },
    {},
    { id: "" },
    { id: undefined },
    { id: "toString" },
    { id: "hasOwnProperty" },
    { id: "雪😀" },
    { id: " " },
  ];
  const before = structuredClone(input);
  let serial = 0;
  const ids = allocateLinearPlanStepIds(input, () => `allocated-${++serial}`);
  assert.deepEqual(ids, [
    "fixed",
    "allocated-1",
    "allocated-2",
    "allocated-3",
    "toString",
    "hasOwnProperty",
    "雪😀",
    " ",
  ]);
  assert.equal(serial, 3);
  assert.deepEqual(input, before);
  assert.deepEqual(
    allocateLinearPlanStepIds(
      ids.map((id) => ({ id })),
      () => {
        throw Error("must not allocate again");
      },
    ),
    ids,
  );
  assert.deepEqual(linearPlanStepIds([]), []);
  assert.throws(
    () => linearPlanStepIds([{}], { allowMissing: false }),
    /步骤ID/,
  );
  assert.throws(
    () => linearPlanStepIds([{ id: "" }], { allowMissing: false }),
    /步骤ID/,
  );
});

test("generated identities are checked against every explicit identity and earlier allocation", () => {
  for (const generated of ["fixed", "", null, "__proto__", "\ud800"])
    assert.throws(
      () => allocateLinearPlanStepIds([{}, { id: "fixed" }], () => generated),
      /步骤ID/,
    );
  assert.throws(
    () => allocateLinearPlanStepIds([{}, {}], () => "same"),
    /步骤ID/,
  );
});

test("identity validation does not inspect request payloads or invoke ID accessors and proxies", () => {
  let reads = 0;
  const request = Object.defineProperty({}, "secret", {
    get() {
      reads++;
      throw Error("payload read");
    },
  });
  assert.deepEqual(linearPlanStepIds([{ id: "safe", request }]), ["safe"]);
  const accessor = Object.defineProperty({}, "id", {
    enumerable: true,
    get() {
      reads++;
      throw Error("ID read");
    },
  });
  const proxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        reads++;
        throw Error("proxy read");
      },
      getOwnPropertyDescriptor() {
        reads++;
        throw Error("proxy read");
      },
    },
  );
  for (const value of [
    [accessor],
    [proxy],
    new Proxy([], {
      get() {
        reads++;
        throw Error("array proxy read");
      },
    }),
  ])
    assert.throws(() => linearPlanStepIds(value), /步骤ID/);
  assert.equal(reads, 0);
});

test("malformed identity containers reject without changing otherwise valid definitions", () => {
  for (const value of [
    null,
    {},
    [null],
    ["step"],
    Array(1),
    Array.from({ length: 201 }, (_, i) => ({ id: String(i) })),
    [Object.create({ id: "inherited" })],
  ])
    assert.throws(() => linearPlanStepIds(value), /步骤ID/);
  const step = Object.defineProperty({}, "id", { value: "hidden" });
  assert.throws(() => linearPlanStepIds([step]), /步骤ID/);
});

test("provenance lookup never inherits Object prototype entries for legitimate opaque IDs", () => {
  for (const id of [
    "toString",
    "hasOwnProperty",
    "valueOf",
    "__defineGetter__",
  ])
    assert.equal(ownStepProvenance({}, id), undefined);
  const map = { toString: "manual", hasOwnProperty: "ai" };
  assert.equal(ownStepProvenance(map, "toString"), "manual");
  assert.equal(ownStepProvenance(map, "hasOwnProperty"), "ai");
  assert.equal(ownStepProvenance(undefined, "ordinary"), undefined);
});
