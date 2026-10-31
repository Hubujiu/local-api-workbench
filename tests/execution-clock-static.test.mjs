import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("execution clocks preserve aggregate limits and separate rounded observations", async () => {
  const read = (name) =>
    readFile(new URL(`../src/${name}.mjs`, import.meta.url), "utf8");
  const dynamic = await read("dynamic-values"),
    load = await read("load-runner");
  for (const source of [dynamic, load]) {
    assert(
      source.includes(
        "const monotonicNow = performance.now.bind(performance);",
      ),
    );
    assert(!source.includes("Date.now"));
  }
  assert(dynamic.includes("const deadline = monotonicNow() + 5000;"));
  assert.equal((dynamic.match(/monotonicNow\(\) > deadline/g) || []).length, 4);
  assert(!dynamic.includes("Math.round"));
  for (const literal of [
    "const started = monotonicNow();",
    "started + timing.durationSeconds * 1000",
    "Math.max(0, deadline - monotonicNow())",
    "if (monotonicNow() >= deadline)",
    '() => stop("duration")',
    'const cancel = () => stop("cancelled");',
    "clearTimeout(timer);",
    "elapsed: Math.max(0, Math.round(monotonicNow() - started))",
    "elapsed: Math.max(0, Math.round(monotonicNow() - iterationStart))",
  ])
    assert(load.includes(literal), literal);
  assert.match(load, /const count = Math\.min\(\s*100,/);
  assert.match(load, /const concurrency = Math\.min\(\s*10,/);
});
