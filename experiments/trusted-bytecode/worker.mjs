import { parentPort, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { createExperimentSession } from "./runtime.mjs";

const started = performance.now();
let session;
try {
  const operations = Object.freeze({
    fixture: ["fixture", "bytecode"],
    loop: ["looping", "bytecode"],
    wait: null,
    unused: null,
    "schema-source": ["schema", "source"],
    "schema-bytecode": ["schema", "bytecode"],
    "schema-first-warm-source": ["schema", "source"],
    "schema-first-warm-bytecode": ["schema", "bytecode"],
    "libraries-source": ["libraries", "source"],
    "libraries-bytecode": ["libraries", "bytecode"],
  });
  if (
    !workerData ||
    Object.keys(workerData).length !== 1 ||
    !Object.hasOwn(operations, workerData.operation)
  )
    throw Error("Unknown fixed worker operation");
  session = await createExperimentSession();
  parentPort.postMessage({ kind: "ready" });
  if (workerData.operation === "wait") await new Promise(() => {});
  const selected = operations[workerData.operation];
  if (selected?.[0] === "libraries")
    session.load("library-prelude", selected[1]);
  if (selected) session.load(...selected);
  if (workerData.operation.startsWith("schema-first-warm-")) {
    // Same ordinary fixed schema/data twice: first compilation then cache hit.
    // No source string or schema arrives through workerData.
    const probe =
      "__boundedJSONSchema({type:'object',properties:{name:{type:'string',minLength:2},age:{type:'integer',minimum:0}},required:['name','age'],additionalProperties:false},{name:'Ada',age:37}).valid";
    for (const phase of [
      "first-schema-validation",
      "cached-schema-validation",
    ]) {
      session.budget.run(phase, () => {
        const result = session.context.evalCode(
          probe,
          "localapi:trusted/fixed-schema-probe.js",
          { type: "global" },
        );
        try {
          if (result.error || !session.context.getNumber(result.value))
            throw Error("Fixed schema validation probe failed");
        } finally {
          (result.error || result.value).dispose();
        }
      });
    }
  }
  parentPort.postMessage({
    kind: "result",
    ok: true,
    activityMs: session.budget.elapsed(),
    metrics: session.budget.metrics,
    heapBytes: session.raw.mallocSize(session.runtime.rt.value),
    elapsed: performance.now() - started,
  });
} catch (error) {
  parentPort.postMessage({
    kind: "result",
    ok: false,
    error: error.message,
    elapsed: performance.now() - started,
  });
} finally {
  session?.dispose();
}
