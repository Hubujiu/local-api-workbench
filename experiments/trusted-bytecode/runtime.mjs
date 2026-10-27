import { readFileSync } from "node:fs";
import { LIMITS, IDS, fixedSource, hash } from "./catalog.mjs";
import { ActivityBudget } from "./budget.mjs";
import { instantiateVerifiedEngine } from "./engine.mjs";
import { verifyEngine, verifyBundle } from "./integrity.mjs";
import { manifestSha256 } from "./pins.mjs";
import { createOwnedRuntime } from "./ownership.mjs";

const assets = new URL("./artifacts/", import.meta.url);
// This module is not imported by any production source. Its sole high-level
// loader accepts a closed id, never bytes/paths/manifests or request options.
export async function createExperimentSession() {
  const budget = new ActivityBudget();
  const verified = budget.run("verify-engine", () => {
    const manifestBytes = readFileSync(new URL("manifest.json", assets));
    if (hash(manifestBytes) !== manifestSha256)
      throw Error("Trusted manifest identity mismatch");
    const manifest = JSON.parse(manifestBytes);
    const engine = JSON.parse(readFileSync(new URL("engine.json", assets)));
    if (JSON.stringify(manifest.engine) !== JSON.stringify(engine))
      throw Error("Trusted manifest engine mismatch");
    const wasm = Buffer.from(
      readFileSync(new URL("engine.wasm.b64", assets), "utf8").trim(),
      "base64",
    );
    const glue = readFileSync(new URL("engine.mjs", assets));
    verifyEngine(
      engine,
      wasm,
      glue,
      readFileSync(new URL("./engine.mjs", import.meta.url)),
    );
    return { manifest, engine, wasm, glue };
  });
  const raw = await budget.runAsync("instantiate-engine", () =>
    instantiateVerifiedEngine(verified.wasm, verified.glue),
  );
  const owned = createOwnedRuntime(raw, budget);
  const { runtime, context } = owned;
  let schemaHolder;
  try {
    budget.run("create-private-export-holder", () => {
      schemaHolder = context.newObject(context.null);
      if (context.typeof(schemaHolder) !== "object")
        throw Error("Private export holder allocation failed");
    });
  } catch (error) {
    try {
      schemaHolder?.dispose();
    } finally {
      owned.dispose();
    }
    throw error;
  }
  let disposed = false,
    schemaAttempted = false;
  const alive = () => {
    if (disposed) throw Error("Experiment session disposed");
    budget.check();
  };
  const evaluateFixed = (id, mode, capture = false) => {
    alive();
    if (!IDS.includes(id) || !["bytecode", "source"].includes(mode))
      throw Error("Unknown fixed experiment operation");
    let returned;
    try {
      budget.run("load-" + mode, () => {
        if (mode === "source") {
          const fixed = fixedSource(id);
          const result = context.evalCode(fixed.source, fixed.filename, {
            type: "global",
          });
          if (result.error) {
            result.error.dispose();
            throw Error("Fixed source evaluation failed");
          }
          if (capture) returned = result.value;
          else result.value.dispose();
          return;
        }
        // Read once -> verify exactly these bytes -> copy exactly these bytes.
        // No second file read, async interleave or mutable shared buffer.
        const bytes = budget.run("verify-bundle", () => {
          const bytes = Buffer.from(
            readFileSync(new URL(id + ".bytecode.b64", assets), "utf8").trim(),
            "base64",
          );
          verifyBundle(verified.manifest, verified.engine, id, bytes);
          return bytes;
        });
        // Allocated before guest code can exhaust the heap; never exposed to it.
        // This immutable fixed export slot is used at most once per session.
        const pointer = raw.alloc(context.ctx.value, bytes.length);
        if (!pointer) throw Error("Trusted bytecode input allocation failed");
        try {
          budget.run("copy-bytecode", () =>
            new Uint8Array(raw.memory.buffer, pointer, bytes.length).set(bytes),
          );
          const status = budget.run("read-evaluate-bytecode", () =>
            capture
              ? raw.readEvalInto(
                  context.ctx.value,
                  pointer,
                  bytes.length,
                  schemaHolder.value,
                )
              : raw.readEval(context.ctx.value, pointer, bytes.length),
          );
          if (status !== 0)
            throw Error("Trusted bytecode evaluation failed: " + status);
          if (capture) returned = context.getProp(schemaHolder, "value");
        } finally {
          raw.free(context.ctx.value, pointer);
        }
      });
      // Assignment occurred inside the charged callback, so a late-success
      // exception cannot lose a newly owned return handle or private holder.
      if (capture)
        budget.run("check-fixed-export", () => {
          if (context.typeof(returned) !== "function")
            throw Error("Trusted fixed export is not callable");
        });
      const result = returned;
      returned = undefined;
      return result;
    } finally {
      returned?.dispose();
    }
  };
  const load = (id, mode = "bytecode") => evaluateFixed(id, mode);
  return {
    load,
    // Private host-only fixed export. No guest arguments can choose its bundle.
    loadSchemaValue(mode = "bytecode") {
      if (schemaAttempted)
        throw Error("Fixed private schema already attempted");
      schemaAttempted = true;
      return evaluateFixed("schema-private", mode, true);
    },
    budget,
    // Test-only direct access, never attached to a worker request or guest global.
    context,
    runtime,
    raw,
    dispose() {
      if (!disposed) {
        disposed = true;
        try {
          schemaHolder.dispose();
        } finally {
          owned.dispose();
        }
      }
    },
  };
}
