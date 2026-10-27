import {
  newQuickJSWASMModuleFromVariant,
  RELEASE_SYNC,
} from "quickjs-emscripten";

// Private host-only primitive. Callers must have checked the SAME supplied
// buffers. Never use an import-by-file after checking a separately read file.
// Emscripten uses import.meta.url only for Node's createRequire/path setup;
// a deterministic binding lets us execute the verified glue from a data URL.
export async function instantiateVerifiedEngine(wasm, glue) {
  const text = glue.toString("utf8");
  if (text.split("import.meta.url").length !== 5)
    throw Error("Unreviewed glue shape");
  const bound = text.replaceAll(
    "import.meta.url",
    JSON.stringify(new URL("./artifacts/engine.mjs", import.meta.url).href),
  );
  const factory = (
    await import(
      "data:text/javascript;base64," + Buffer.from(bound).toString("base64")
    )
  ).default;
  let module;
  const engine = await newQuickJSWASMModuleFromVariant({
    type: "sync",
    importFFI: RELEASE_SYNC.importFFI,
    importModuleLoader: async () => async (options) => {
      module = await factory({ ...options, wasmBinary: wasm });
      return module;
    },
  });
  const extensions = module.quickjsEmscriptenInit();
  const bind = (name, argc) =>
    module.cwrap(name, "number", Array(argc).fill("number"));
  return {
    engine,
    module,
    alloc: bind("QTS_TrustedBytecodeAlloc", 2),
    free: bind("QTS_TrustedBytecodeFree", 2),
    write: bind("QTS_TrustedBytecodeWrite", 3),
    readEval: bind("QTS_TrustedBytecodeReadEval", 3),
    mallocSize: bind("QTS_TrustedMallocSize", 1),
    memory: extensions.getWasmMemory(),
  };
}
