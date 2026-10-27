import { readFileSync } from "node:fs";
import { ABI, UPSTREAM, EMSDK, FLAGS, fixedSource, hash } from "./catalog.mjs";

export const BASELINE_PATCH_FIELDS = Object.freeze({
  "rejection-tracker.patch": "patchSha256",
  "heap-accounting.patch": "heapPatchSha256",
  "regexp-interrupt.patch": "regexpInterruptPatchSha256",
  "unicode-script-oom.patch": "unicodeScriptOOMPatchSha256",
});
export const BASELINE_SOURCE_FIELDS = Object.freeze({
  "c/interface.c": "patchedSourceSha256",
  "packages/variant-quickjs-wasmfile-release-sync/Makefile":
    "patchedMakefileSha256",
  "vendor/quickjs/quickjs.c": "patchedQuickJSSourceSha256",
  "vendor/quickjs/libregexp.c": "patchedRegExpSourceSha256",
  "vendor/quickjs/libregexp.h": "patchedRegExpHeaderSha256",
  "vendor/quickjs/libunicode.c": "patchedUnicodeSourceSha256",
});
const baselineSourceCommits = Object.freeze({
  regexpInterruptSourceCommit: "25aaa7737020d7ca98926abc532acc6c5755d562",
  unicodeScriptOOMSourceCommit: "817509a87c3c0af362df576574784bae0dae8129",
});

// Pure negative-test helper: supplied bytes are only hashed, never executed or
// installed. All actual builder/runtime callers use readVerifiedBaseline below.
export function verifyBaselineInputs(baseline, patches, wasm, glue) {
  if (
    baseline.sourceRepository !==
      "https://github.com/justjake/quickjs-emscripten" ||
    baseline.sourceCommit !== UPSTREAM ||
    baseline.sourceTag !== "v0.31.0" ||
    baseline.emsdkCommit !== EMSDK ||
    baseline.emscripten !== "3.1.65" ||
    baseline.closureCompiler !== false ||
    Object.entries(baselineSourceCommits).some(
      ([key, value]) => baseline[key] !== value,
    ) ||
    [
      ...Object.values(BASELINE_PATCH_FIELDS),
      ...Object.values(BASELINE_SOURCE_FIELDS),
      "wasmSha256",
      "glueSha256",
    ].some((key) => !/^[a-f0-9]{64}$/.test(baseline[key] || ""))
  )
    throw Error("Unreviewed fixed baseline identity");
  for (const [name, field] of Object.entries(BASELINE_PATCH_FIELDS)) {
    if (
      !Buffer.isBuffer(patches[name]) ||
      hash(patches[name]) !== baseline[field]
    )
      throw Error("Unreviewed baseline patch: " + name);
  }
  if (hash(wasm) !== baseline.wasmSha256 || hash(glue) !== baseline.glueSha256)
    throw Error("Actual production baseline artifact identity mismatch");
  return {
    interfaceBaseSha256: baseline.patchedSourceSha256,
    ...Object.fromEntries(
      Object.values(BASELINE_SOURCE_FIELDS)
        .filter((field) => field !== "patchedSourceSha256")
        .map((field) => [field, baseline[field]]),
    ),
    baselinePatchSha256: baseline.patchSha256,
    heapPatchSha256: baseline.heapPatchSha256,
    regexpInterruptPatchSha256: baseline.regexpInterruptPatchSha256,
    unicodeScriptOOMPatchSha256: baseline.unicodeScriptOOMPatchSha256,
    ...baselineSourceCommits,
    baselineWasmSha256: hash(wasm),
    baselineGlueSha256: hash(glue),
  };
}

// Single fixed, read-only baseline source. The production WASM/glue are hashed
// as actual bytes, not accepted merely because manifest metadata names them.
// The private bridge still uses its own separately verified engine artifacts.
export function readVerifiedBaseline() {
  const base = new URL("../../src/vendor/quickjs-tracked/", import.meta.url);
  const manifest = readFileSync(new URL("manifest.json", base));
  const baseline = JSON.parse(manifest);
  const patches = Object.fromEntries(
    Object.keys(BASELINE_PATCH_FIELDS).map((name) => [
      name,
      readFileSync(new URL(name, base)),
    ]),
  );
  const wasm = Buffer.from(
    readFileSync(new URL("emscripten-module.wasm.b64", base), "utf8").trim(),
    "base64",
  );
  const glue = readFileSync(new URL("emscripten-module.js", base));
  const identity = {
    ...verifyBaselineInputs(baseline, patches, wasm, glue),
    baselineManifestSha256: hash(manifest),
  };
  const sources = Object.fromEntries(
    Object.entries(BASELINE_SOURCE_FIELDS).map(([name, field]) => [
      name,
      baseline[field],
    ]),
  );
  return { baseline, identity, sources };
}

// Pure verification helper for builder and ordinary mismatch tests. It does not
// call C, instantiate a runtime or install a caller-supplied manifest.
export function verifyEngine(identity, wasm, glue, loader) {
  const { identity: baselineIdentity } = readVerifiedBaseline();
  const builder = readFileSync(new URL("./build-runtime.mjs", import.meta.url));
  const verifier = readFileSync(new URL("./build-inputs.mjs", import.meta.url));
  const expected = {
    ...baselineIdentity,
    integrityVerifierSha256: hash(readFileSync(new URL(import.meta.url))),
    bridgeSha256: hash(readFileSync(new URL("./bridge.c", import.meta.url))),
    builderSha256: hash(builder),
    inputVerifierSha256: hash(verifier),
    buildRecipeSha256: hash(
      Buffer.concat([builder, Buffer.from("\0"), verifier]),
    ),
  };
  if (
    Object.entries(expected).some(([key, value]) => identity[key] !== value) ||
    [
      "sourceInputsSha256",
      "patchedSourceSha256",
      "sdkTrackedSha256",
      "sdkDistributionSha256",
      "sdkNodeSha256",
      "sdkConfigSha256",
      "executionRecipeSha256",
    ].some((key) => !/^[a-f0-9]{64}$/.test(identity[key] || "")) ||
    identity.abi !== ABI ||
    identity.sourceCommit !== UPSTREAM ||
    identity.emscripten !== "3.1.65" ||
    identity.emsdkCommit !== EMSDK ||
    hash(wasm) !== identity.wasmSha256 ||
    hash(glue) !== identity.glueSha256 ||
    hash(loader) !== identity.loaderSha256
  )
    throw Error("Trusted bytecode engine identity mismatch");
}
export function verifyBundle(manifest, engine, id, bytes) {
  const fixed = fixedSource(id);
  const entry = manifest.bundles[id];
  if (
    manifest.abi !== ABI ||
    JSON.stringify(manifest.engine) !== JSON.stringify(engine) ||
    !entry ||
    entry.id !== id ||
    entry.filename !== fixed.filename ||
    entry.sourceSha256 !== fixed.sourceSha256 ||
    entry.wrapperSha256 !== fixed.wrapperSha256 ||
    JSON.stringify(entry.flags) !== JSON.stringify(FLAGS) ||
    entry.byteLength !== bytes.length ||
    hash(bytes) !== entry.bytecodeSha256
  )
    throw Error("Trusted bytecode bundle identity mismatch");
}
