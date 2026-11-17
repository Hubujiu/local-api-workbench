import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { intrinsicGuard } from "../scripts/sandbox-intrinsic-guard.mjs";

const realm = () => {
  const context = vm.createContext({});
  vm.runInContext(
    `const intrinsicGuard = (${intrinsicGuard.toString()});`,
    context,
  );
  return context;
};

test("XML intrinsic snapshot reads accessor descriptor fields without invoking the accessor", () => {
  const context = realm();
  vm.runInContext(
    `
    let calls = 0;
    const read = function () { calls++; throw Error("getter invoked"); };
    Object.defineProperty(globalThis, "document", {get: read, configurable: true});
    const check = intrinsicGuard();
    check();
  `,
    context,
  );
  assert.equal(vm.runInContext("calls", context), 0);
  vm.runInContext("read.changed = true", context);
  assert.throws(() => vm.runInContext("check()", context), /XML内建对象/);
  assert.equal(vm.runInContext("calls", context), 0);
});

test("XML intrinsic snapshot never reads inherited descriptor value/get/set fields", () => {
  const context = realm();
  vm.runInContext(
    `
    let calls = 0;
    for (const name of ["value", "get", "set"]) {
      const record = Object.create(null);
      record.get = function () { calls++; throw Error("inherited descriptor field"); };
      record.configurable = true;
      Object.defineProperty(Object.prototype, name, record);
    }
    const check = intrinsicGuard();
    check();
  `,
    context,
  );
  assert.equal(vm.runInContext("calls", context), 0);
  vm.runInContext("delete Object.prototype.value", context);
  assert.throws(() => vm.runInContext("check()", context), /XML内建对象/);
  assert.equal(vm.runInContext("calls", context), 0);
});

test("XML intrinsic snapshot retains symbol-keyed and nested function graph checks", () => {
  const context = realm();
  vm.runInContext(
    `
    const key = Symbol("nested");
    const nested = function () {};
    Object.prototype.hasOwnProperty[key] = nested;
    const check = intrinsicGuard();
    check();
    nested.changed = true;
  `,
    context,
  );
  assert.throws(() => vm.runInContext("check()", context), /XML内建对象/);
});
