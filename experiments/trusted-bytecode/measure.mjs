// Fixed, sequential fresh-worker samples; no arbitrary bundle/source/path input.
// This is a diagnostic, not a timing threshold, benchmark guarantee or fix claim.
import { Worker } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { LIMITS } from "./catalog.mjs";

if (process.argv.length > 2)
  throw Error("Fixed measurement accepts no arguments");
const operations = [
  "unused",
  "schema-source",
  "schema-bytecode",
  "schema-first-warm-source",
  "schema-first-warm-bytecode",
  "libraries-source",
  "libraries-bytecode",
];
const results = Object.fromEntries(operations.map((op) => [op, []]));
function run(operation) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const worker = new Worker(new URL("./worker.mjs", import.meta.url), {
      workerData: { operation },
    });
    let settled = false;
    const finish = async (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await worker.terminate();
      const totalMs = performance.now() - start;
      if (error) reject(error);
      else if (totalMs >= LIMITS.wallMs)
        reject(Error("2s worker wall deadline during teardown"));
      else resolve({ ...value, totalMs });
    };
    const timer = setTimeout(
      () => finish(Error("2s worker wall deadline")),
      LIMITS.wallMs,
    );
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) => {
      if (!settled) finish(Error("Worker exited without result: " + code));
    });
    worker.on("message", (message) => {
      if (message.kind !== "result") return;
      const totalMs = performance.now() - start;
      if (totalMs >= LIMITS.wallMs)
        return finish(Error("Late worker success rejected"));
      finish(null, { ...message, resultMs: totalMs });
    });
  });
}
for (let sample = 0; sample < 10; sample++) {
  // Rotate order to avoid measuring only one mode after the filesystem warms.
  const order = operations
    .slice(sample % operations.length)
    .concat(operations.slice(0, sample % operations.length));
  for (const operation of order) results[operation].push(await run(operation));
}
const summarize = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  return {
    min: sorted[0],
    median: (sorted[4] + sorted[5]) / 2,
    max: sorted.at(-1),
  };
};
console.log(
  JSON.stringify(
    {
      kind: "fixed-trusted-bytecode-fresh-worker-samples",
      note: "Ten sequential workers per operation on one host/process; success follows guest disposal, total includes worker termination. Not cold-process or cross-platform performance proof.",
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      engine: JSON.parse(
        readFileSync(new URL("./artifacts/engine.json", import.meta.url)),
      ),
      limits: LIMITS,
      summary: Object.fromEntries(
        operations.map((op) => [
          op,
          {
            successes: results[op].filter((x) => x.ok).length,
            failures: results[op].filter((x) => !x.ok).map((x) => x.error),
            totalMs: summarize(results[op].map((x) => x.totalMs)),
            schemaPhasesMs:
              op.startsWith("schema-first-warm-") &&
              results[op].every((x) => x.ok)
                ? {
                    first: summarize(
                      results[op].map(
                        (x) => x.metrics["first-schema-validation"],
                      ),
                    ),
                    cached: summarize(
                      results[op].map(
                        (x) => x.metrics["cached-schema-validation"],
                      ),
                    ),
                  }
                : null,
            activeMs: results[op].every((x) => x.ok)
              ? summarize(results[op].map((x) => x.activityMs))
              : null,
          },
        ]),
      ),
      results,
    },
    null,
    2,
  ),
);
if (operations.some((op) => results[op].some((x) => !x.ok)))
  process.exitCode = 1;
