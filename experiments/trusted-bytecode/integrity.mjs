import { readFileSync } from "node:fs";
import { ABI, UPSTREAM, EMSDK, FLAGS, fixedSource, hash } from "./catalog.mjs";

// Pure verification helper for builder and ordinary mismatch tests. It does not
// call C, instantiate a runtime or install a caller-supplied manifest.
export function verifyEngine(identity, wasm, glue, loader) {
  const base = new URL("../../src/vendor/quickjs-tracked/", import.meta.url);
  const baseline = JSON.parse(readFileSync(new URL("manifest.json", base)));
  const builder = readFileSync(new URL("./build-runtime.mjs", import.meta.url));
  const verifier = readFileSync(new URL("./build-inputs.mjs", import.meta.url));
  const expected = {
    bridgeSha256: hash(readFileSync(new URL("./bridge.c", import.meta.url))),
    interfaceBaseSha256: baseline.patchedSourceSha256,
    patchedQuickJSSourceSha256: baseline.patchedQuickJSSourceSha256,
    patchedMakefileSha256: baseline.patchedMakefileSha256,
    baselinePatchSha256: baseline.patchSha256,
    heapPatchSha256: baseline.heapPatchSha256,
    builderSha256: hash(builder),
    inputVerifierSha256: hash(verifier),
    buildRecipeSha256: hash(
      Buffer.concat([builder, Buffer.from("\0"), verifier]),
    ),
  };
  if (
    Object.entries(expected).some(([key, value]) => identity[key] !== value) ||
    baseline.sourceCommit !== UPSTREAM ||
    baseline.emsdkCommit !== EMSDK ||
    hash(readFileSync(new URL("rejection-tracker.patch", base))) !==
      baseline.patchSha256 ||
    hash(readFileSync(new URL("heap-accounting.patch", base))) !==
      baseline.heapPatchSha256 ||
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
