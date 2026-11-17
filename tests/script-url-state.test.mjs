import test from "node:test";
import assert from "node:assert/strict";
import sdk from "../src/vendor/url-sdk-host.js";
import {
  validateURLSnapshot,
  captureURLSnapshot,
} from "../src/script-url-state.mjs";
const snapshot = (url) => ({ version: 1, url: url.toJSON() });
test("phase snapshot preserves SDK syntax, flag rows, disabled rows and metadata", () => {
  for (const raw of [
    "https://example.test/?",
    "https://example.test/#",
    "https://example.test:/a",
    "https://u:p@example.test/a/../b#hash",
    "https://{{host}}/a/{{x?y}}?x=1&&",
  ]) {
    const url = new sdk.Url(raw);
    const state = validateURLSnapshot(snapshot(url));
    assert.equal(new sdk.Url(state.url).toString(), raw);
  }
  const url = new sdk.Url("https://example.test/:id?x=1&x=2&flag");
  url.query.add({
    key: "off",
    value: "hidden",
    disabled: true,
    description: "keep",
  });
  url.variables.upsert({ key: "id", value: "abc", disabled: false });
  const before = snapshot(url),
    checked = validateURLSnapshot(before),
    after = snapshot(new sdk.Url(checked.url));
  assert.deepEqual(after, before);
  checked.url.query[0].value = "changed";
  assert.equal(url.query.all()[0].value, "1");
});
test("typed variable JSON survives without executing hooks and key-like names stay data", () => {
  const url = new sdk.Url("https://example.test");
  const data = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":"data"}',
  );
  url.variables.add({ key: "x", value: data, type: "any" });
  const checked = validateURLSnapshot(snapshot(url));
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.hasOwn(checked.url.variable[0].value, "__proto__"), true);
  for (const value of [
    undefined,
    () => 1,
    Symbol("x"),
    1n,
    NaN,
    Infinity,
    new Date(),
  ]) {
    const state = snapshot(new sdk.Url("https://example.test"));
    state.url.variable.push({ key: "x", type: "any", value });
    assert.throws(() => validateURLSnapshot(state), /URL状态无效/);
  }
});
test("accessors, hidden fields, symbols, sparse arrays, cycles and unknown fields reject atomically", () => {
  let calls = 0;
  for (const mutate of [
    (s) =>
      Object.defineProperty(s.url, "host", {
        get() {
          calls++;
          return ["bad"];
        },
        enumerable: true,
      }),
    (s) => Object.defineProperty(s.url, "hidden", { value: 1 }),
    (s) => (s.url[Symbol("x")] = 1),
    (s) => (s.url.query.length = 2),
    (s) => (s.url.query.extra = "x"),
    (s) => s.url.query.push(s.url),
    (s) => (s.url.unknown = true),
    (s) =>
      s.url.variable.push({
        key: "secret",
        type: "any",
        source: { provider: "external" },
      }),
  ]) {
    const state = snapshot(new sdk.Url("https://example.test"));
    mutate(state);
    assert.throws(() => validateURLSnapshot(state), /URL状态无效/);
  }
  assert.equal(calls, 0);
});
test("snapshot budgets reject before phase use without changing input", () => {
  for (const value of ["x".repeat(65536), "中".repeat(22000), "\ud800"]) {
    const state = snapshot(new sdk.Url("https://example.test"));
    state.url.query.push({ key: "x", value });
    assert.throws(() => validateURLSnapshot(state), /URL状态无效/);
    assert.equal(state.url.query[0].value, value);
  }
  const state = snapshot(new sdk.Url("https://example.test"));
  state.url.query = Array.from({ length: 1001 }, () => ({
    key: "x",
    value: "y",
  }));
  assert.throws(() => validateURLSnapshot(state), /成员超限/);
});

test("fresh isolated phases transfer only bounded JSON state and retain flag metadata", async () => {
  const { readFile } = await import("node:fs/promises");
  const { trackedQuickJS } = await import("../src/tracked-quickjs.mjs");
  const source = await readFile(
    new URL("../src/vendor/url-sdk.js", import.meta.url),
    "utf8",
  );
  const evaluate = async (code) => {
    const tracked = await trackedQuickJS(),
      runtime = tracked.engine.newRuntime();
    runtime.setMemoryLimit(16 * 1024 * 1024);
    runtime.setMaxStackSize(512 * 1024);
    const context = runtime.newContext(),
      start = Date.now();
    runtime.setInterruptHandler(() => Date.now() - start > 250);
    try {
      const result = context.evalCode(
        source +
          ";const validateURLSnapshot=" +
          validateURLSnapshot.toString() +
          ";const captureURLSnapshot=" +
          captureURLSnapshot.toString() +
          ";" +
          code,
      );
      if (result.error) {
        const e = context.dump(result.error);
        result.error.dispose();
        throw Error(JSON.stringify(e));
      }
      const value = context.getString(result.value);
      result.value.dispose();
      return JSON.parse(value);
    } finally {
      context.dispose();
      runtime.dispose();
    }
  };
  const first = await evaluate(`(()=>{
   const u=new LocalURLSDK.Url('https://example.test/:id?x=1&x=2&flag');
   u.variables.upsert({key:'id',value:'42'});
   u.query.one('x').disabled=true;
   u.query.add({key:'off',value:'hidden',disabled:true,description:'retained'});
   globalThis.privatePhaseValue='must not cross';
   return JSON.stringify(captureURLSnapshot(u));
 })()`);
  const transfer = validateURLSnapshot(JSON.parse(JSON.stringify(first)));
  const second = await evaluate(`(()=>{
   const state=validateURLSnapshot(${JSON.stringify(transfer)});
   const u=new LocalURLSDK.Url(state.url);
   return JSON.stringify({url:u.toString(),rows:u.query.toJSON(),privateValue:typeof privatePhaseValue,host:typeof process});
 })()`);
  assert.equal(second.url, "https://example.test/42?x=1&flag");
  assert.equal(second.rows[3].disabled, true);
  assert.equal(second.rows[3].description.content, "retained");
  assert.equal(second.privateValue, "undefined");
  assert.equal(second.host, "undefined");
});

test("capture avoids SDK serialization loss and rejects function values before transfer", () => {
  const url = new sdk.Url("https://example.test/:id?q=1&flag");
  url.variables.upsert({ key: "id", value: "x" });
  url.query.add({ key: "empty" });
  assert.deepEqual(captureURLSnapshot(url), snapshot(url));
  let calls = 0;
  url.variables.upsert({ key: "id", value: () => ++calls });
  assert.throws(() => captureURLSnapshot(url), /URL状态无效/);
  assert.equal(calls, 0);
  url.variables.upsert({ key: "id", value: "valid" });
  Object.defineProperty(url.query.one("q"), "value", {
    get() {
      calls++;
      return "bad";
    },
    enumerable: true,
  });
  assert.throws(() => captureURLSnapshot(url), /URL状态无效/);
  assert.equal(calls, 0);
});

test("snapshot byte limits include JSON escaping and UTF-8 exactly", () => {
  const state = snapshot(new sdk.Url("https://example.test"));
  state.url.query.push({ key: "x", value: "" });
  const overhead = Buffer.byteLength(JSON.stringify(state));
  state.url.query[0].value = "x".repeat(65536 - overhead);
  assert.equal(
    Buffer.byteLength(JSON.stringify(validateURLSnapshot(state))),
    65536,
  );
  state.url.query[0].value += "x";
  assert.throws(() => validateURLSnapshot(state), /64KiB/);
  state.url.query[0].value = "\n".repeat(Math.floor((65536 - overhead) / 2));
  assert(
    Buffer.byteLength(JSON.stringify(validateURLSnapshot(state))) <= 65536,
  );
  state.url.query[0].value += "\n";
  assert.throws(() => validateURLSnapshot(state), /64KiB/);
  state.url.query[0].value = "😀".repeat(Math.floor((65536 - overhead) / 4));
  assert(
    Buffer.byteLength(JSON.stringify(validateURLSnapshot(state))) <= 65536,
  );
  state.url.query[0].value += "😀";
  assert.throws(() => validateURLSnapshot(state), /64KiB/);
});
