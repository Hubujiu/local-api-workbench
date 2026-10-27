import { ABI, UPSTREAM, EMSDK, FLAGS, fixedSource, hash } from "./catalog.mjs";

// Pure verification helper for builder and ordinary mismatch tests. It does not
// call C, instantiate a runtime or install a caller-supplied manifest.
export function verifyEngine(identity, wasm, glue, loader) {
  if (
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
