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

test("native Mock cumulative clock fixture stays isolated from real elapsed-time coverage", async () => {
  // Read source only: this test must never import the executable VM fixture.
  const [suite, fixture] = await Promise.all([
    readFile(new URL("./native-mock-budget.test.mjs", import.meta.url), "utf8"),
    readFile(
      new URL("./fixtures/native-mock-budget-clock.mjs", import.meta.url),
      "utf8",
    ),
  ]);
  assert(suite.includes("withSlowOutputParse(300, (outputs) => {"));
  assert(suite.includes("assert(performance.now() - started >= 250);"));
  assert(!suite.includes("withSlowOutputParse(160"));
  assert(!suite.includes('Object.defineProperty(performance, "now"'));
  assert.match(suite, /spawnSync\(\s*process\.execPath,/);
  assert(suite.includes("./fixtures/native-mock-budget-clock.mjs"));
  assert(suite.includes('killSignal: "SIGKILL"'));
  assert(suite.includes("assert.ifError(child.error);"));
  assert(suite.includes("assert.equal(child.signal, null, child.stderr);"));
  assert(suite.includes("assert.equal(child.status, 0, child.stderr);"));
  assert(suite.includes("assert.deepEqual(JSON.parse(child.stdout), {"));
  assert(!fixture.includes("Atomics.wait"));
  assert(!fixture.includes('from "../../src/'));
  assert.match(
    fixture,
    /Object\.defineProperty\(performance, "now",[\s\S]*await import\(\s*"\.\.\/\.\.\/src\/native-mock-library\.mjs"\s*\)[\s\S]*finally\s*{\s*if \(ownNow\) Object\.defineProperty\(performance, "now", ownNow\);\s*else delete performance\.now;/,
  );
  assert(fixture.includes("assert.equal(performance.now, originalNow);"));
  assert.match(fixture, /finally\s*{\s*JSON\.parse = parse;\s*}/);
  for (const literal of [
    "elapsed += 160;",
    "assert.equal(elapsed, 160);",
    "assert.equal(elapsed, 320);",
    "assert.equal(elapsed, 480);",
    "assert.throws(() => scope.evaluate(spec), budgetError);",
    'assert.equal(typeof fresh.evaluate(spec), "string");',
  ])
    assert(fixture.includes(literal), literal);
});
