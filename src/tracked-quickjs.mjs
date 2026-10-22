import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  newQuickJSWASMModuleFromVariant,
  RELEASE_SYNC,
} from "quickjs-emscripten";
const assets = new URL("./vendor/quickjs-tracked/", import.meta.url);
const hash = (value) => createHash("sha256").update(value).digest("hex");
async function verifiedAssets(includeWasm) {
  const manifest = JSON.parse(
    await readFile(new URL("manifest.json", assets), "utf8"),
  );
  const glue = await readFile(new URL("emscripten-module.js", assets), "utf8");
  let wasm;
  if (includeWasm)
    wasm = Buffer.from(
      await readFile(new URL("emscripten-module.wasm.b64", assets), "utf8"),
      "base64",
    );
  if (
    hash(glue.replace(/\r\n/g, "\n")) !== manifest.glueSha256 ||
    (wasm && hash(wasm) !== manifest.wasmSha256)
  )
    throw Error("脚本引擎完整性校验失败");
  return { manifest, wasm };
}

/** Compile immutable application code once; no runtime, memory or user state is cached. */
export async function compileTrackedQuickJS() {
  const { manifest, wasm } = await verifiedAssets(true);
  return {
    module: await WebAssembly.compile(wasm),
    wasmSha256: manifest.wasmSha256,
    glueSha256: manifest.glueSha256,
  };
}

/** Every invocation still creates a fresh WASM instance, runtime and rejection tracker. */
export async function trackedQuickJS(compiled) {
  const { manifest, wasm } = await verifiedAssets(!compiled);
  if (
    compiled &&
    (!(compiled.module instanceof WebAssembly.Module) ||
      compiled.wasmSha256 !== manifest.wasmSha256 ||
      compiled.glueSha256 !== manifest.glueSha256)
  )
    throw Error("脚本引擎编译缓存完整性校验失败");
  const factory = (await import(new URL("emscripten-module.js", assets).href))
    .default;
  let module;
  const engine = await newQuickJSWASMModuleFromVariant({
    type: "sync",
    importFFI: RELEASE_SYNC.importFFI,
    importModuleLoader: async () => async (options) => {
      module = await factory({
        ...options,
        ...(compiled
          ? {
              instantiateWasm(imports, receiveInstance) {
                const instance = new WebAssembly.Instance(
                  compiled.module,
                  imports,
                );
                receiveInstance(instance, compiled.module);
                return instance.exports;
              },
            }
          : { wasmBinary: wasm }),
      });
      return module;
    },
  });
  return {
    engine,
    version: manifest.runtime,
    unhandledCount: module.cwrap("QTS_UnhandledRejectionCount", "number", []),
    unhandledMessage: module.cwrap(
      "QTS_UnhandledRejectionMessage",
      "string",
      [],
    ),
  };
}
