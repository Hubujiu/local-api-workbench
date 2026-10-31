import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("native Mock keeps monotonic shared limits and rejects after charged cleanup", async () => {
  const source = await readFile(
    new URL("../src/native-mock-library.mjs", import.meta.url),
    "utf8",
  );
  for (const literal of [
    "const monotonicNow = performance.now.bind(performance);",
    "runtime.setMemoryLimit(16 * 1024 * 1024);",
    "runtime.setMaxStackSize(512 * 1024);",
    "let deadline = monotonicNow() + 1000,",
    "remaining = 250,",
    "runtime.setInterruptHandler(() => monotonicNow() > deadline);",
    "if (++calls > 1000 || remaining <= 0)",
    "const start = monotonicNow();",
    "deadline = start + remaining;",
    "if (Buffer.byteLength(text) > 65536)",
    "value = JSON.parse(text);",
    'if (remaining < 0) throw Error("原版Mock库运行额度已用尽");',
  ])
    assert(source.includes(literal), literal);
  assert(!source.includes("Date.now"));
  assert.match(
    source,
    /finally\s*{\s*try\s*{\s*handle\?\.dispose\(\);\s*}\s*finally\s*{\s*remaining -= monotonicNow\(\) - start;\s*}\s*}\s*\/\/[\s\S]*?if \(remaining < 0\)[^\n]+\n\s*return value;/,
  );
  const evaluate = source.slice(source.indexOf("evaluate(spec) {"));
  assert(!evaluate.includes("remaining = 250"));
  assert(!evaluate.includes("Math.round"));
});
