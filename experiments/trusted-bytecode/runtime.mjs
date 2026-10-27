import { readFileSync } from "node:fs";
import { LIMITS, IDS, fixedSource, hash } from "./catalog.mjs";
import { ActivityBudget } from "./budget.mjs";
import { instantiateVerifiedEngine } from "./engine.mjs";
import { verifyEngine, verifyBundle } from "./integrity.mjs";
import { manifestSha256 } from "./pins.mjs";

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
  const runtime = raw.engine.newRuntime();
  runtime.setMemoryLimit(LIMITS.memory);
  runtime.setMaxStackSize(LIMITS.stack);
  runtime.setInterruptHandler(() => budget.expired());
  let context;
  try {
    context = budget.run("create-context", () => runtime.newContext());
  } catch (error) {
    runtime.dispose();
    throw error;
  }
  let disposed = false;
  const alive = () => {
    if (disposed) throw Error("Experiment session disposed");
    budget.check();
  };
  const load = (id, mode = "bytecode") => {
    alive();
    if (!IDS.includes(id) || !["bytecode", "source"].includes(mode))
      throw Error("Unknown fixed experiment operation");
    return budget.run("load-" + mode, () => {
      if (mode === "source") {
        const fixed = fixedSource(id);
        const result = context.evalCode(fixed.source, fixed.filename, {
          type: "global",
        });
        if (result.error) {
          result.error.dispose();
          throw Error("Fixed source evaluation failed");
        }
        result.value.dispose();
        return;
      }
      // Read once -> verify exactly these bytes -> copy exactly these bytes.
      // There is no second file read, async interleave or mutable shared buffer.
      const bytes = Buffer.from(
        readFileSync(new URL(id + ".bytecode.b64", assets), "utf8").trim(),
        "base64",
      );
      verifyBundle(verified.manifest, verified.engine, id, bytes);
      const pointer = raw.alloc(context.ctx.value, bytes.length);
      if (!pointer) throw Error("Trusted bytecode input allocation failed");
      try {
        new Uint8Array(raw.memory.buffer, pointer, bytes.length).set(bytes);
        budget.check();
        const status = raw.readEval(context.ctx.value, pointer, bytes.length);
        if (status !== 0)
          throw Error("Trusted bytecode evaluation failed: " + status);
      } finally {
        raw.free(context.ctx.value, pointer);
      }
    });
  };
  return {
    load,
    budget,
    // Test-only direct access, never attached to a worker request or guest global.
    context,
    runtime,
    raw,
    dispose() {
      if (!disposed) {
        disposed = true;
        context.dispose();
        runtime.dispose();
      }
    },
  };
}
