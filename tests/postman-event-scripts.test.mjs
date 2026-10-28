import test from "node:test";
import assert from "node:assert/strict";
import { postmanEventScripts } from "../src/postman-event-scripts.mjs";

// Pure data normalization only: never imports core, a VM, server or database.
const event = (exec, extra = {}) => ({
  listen: "prerequest",
  script: { exec },
  ...extra,
});

test("inline event sources preserve exact text, empty lines, phase and order without executing", () => {
  const input = [
    event("throw Error('source is data');\r\n// first"),
    event(["", "// second", ""]),
    event("// after", { listen: "test" }),
    { listen: "test" },
    { listen: "test", script: {} },
    { listen: "test", script: { exec: [] } },
  ];
  const before = structuredClone(input);
  assert.deepEqual(postmanEventScripts(input), {
    prerequest: ["throw Error('source is data');\r\n// first", "", "// second", ""],
    test: ["// after"],
  });
  assert.deepEqual(input, before);
  assert.deepEqual(postmanEventScripts(undefined), { prerequest: [], test: [] });
});

test("only boolean event.disabled suppresses a source and disabled payload is never read", () => {
  const off = { listen: "prerequest", disabled: true };
  Object.defineProperty(off, "script", {
    enumerable: true,
    get() { throw Error("disabled payload was read"); },
  });
  assert.deepEqual(postmanEventScripts([off, event("on", { disabled: false })]), {
    prerequest: ["on"], test: [],
  });
  assert.deepEqual(postmanEventScripts([event("const broken = ;", { disabled: true })]), {
    prerequest: [], test: [],
  });
  for (const disabled of [undefined, null, 0, 1, "false", "true", {}, []])
    assert.throws(() => postmanEventScripts([event("x", { disabled })]), /disabled/);
});

test("metadata and JavaScript MIME labels do not select an invented interpreter", () => {
  for (const type of ["text/javascript", "application/javascript", "application/ecmascript", "text/ecmascript", "", "custom-label"])
    assert.deepEqual(postmanEventScripts([{
      id: "event-id", name: "event-name", description: "event description", listen: "test",
      script: { id: "script-id", name: "script-name", description: { content: "description", type: "text/plain" }, type, exec: "// same JS" },
    }]), { prerequest: [], test: ["// same JS"] });
});

test("ambiguous active sources and execution dependencies fail instead of coercing or dropping", () => {
  const badScripts = [
    null, false, 1, "code", [],
    ...[null, false, true, 0, 1, {}, ["ok", 1], [null], [["nested"]]].map((exec) => ({ exec })),
    { exec: "inline", src: "https://example.invalid/script.js" },
    { src: { raw: "file:///never-read.js" } },
    { exec: "inline", src: "" },
    { exec: "inline", disabled: true },
    { exec: "inline", disabled: false },
    { exec: "inline", packages: {} },
    { exec: "inline", requests: {} },
    { exec: "inline", unknownExecutionOption: true },
    { exec: "inline", type: null },
    { exec: "inline", id: 42 },
  ];
  for (const script of badScripts)
    assert.throws(() => postmanEventScripts([{ listen: "test", script }]), /Postman/);
  for (const input of [null, false, 0, "", {}, [null], [[]], [{}], [{ listen: 1 }], [{ listen: "other" }], [{ listen: "test", extra: true }]])
    assert.throws(() => postmanEventScripts(input), /Postman/);
});

test("active accessors, sparse arrays and inherited values are not read or coerced", () => {
  let touches = 0;
  const accessor = {};
  Object.defineProperty(accessor, "exec", { enumerable: true, get() { touches++; return "bad"; } });
  for (const script of [accessor, Object.create({ exec: "bad" }), { exec: Array(1) }])
    assert.throws(() => postmanEventScripts([{ listen: "test", script }]), /Postman/);
  assert.throws(() => postmanEventScripts(Array(1)), /Postman/);
  assert.equal(touches, 0);
});

test("normalization is all-or-error and respects the existing 100000 character phase ceiling", () => {
  const input = [event("valid"), event(["invalid", {}])];
  const before = structuredClone(input);
  assert.throws(() => postmanEventScripts(input), /Postman/);
  assert.deepEqual(input, before);
  assert.equal(postmanEventScripts([event("x".repeat(100000))]).prerequest[0].length, 100000);
  assert.throws(() => postmanEventScripts([event("x".repeat(100000)), event("x")]), /100000/);
});
