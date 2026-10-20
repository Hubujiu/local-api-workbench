import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  newQuickJSWASMModuleFromVariant,
  RELEASE_SYNC,
} from "quickjs-emscripten";
const assets = new URL("./vendor/quickjs-tracked/", import.meta.url);
const hash = (value) => createHash("sha256").update(value).digest("hex");
/** A fresh module per script: rejection state is never shared between workers. */
export async function trackedQuickJS() {
  const manifest = JSON.parse(
    await readFile(new URL("manifest.json", assets), "utf8"),
  );
  const [glue, encoded] = await Promise.all([
    readFile(new URL("emscripten-module.js", assets), "utf8"),
    readFile(new URL("emscripten-module.wasm.b64", assets), "utf8"),
  ]);
  const wasm = Buffer.from(encoded, "base64");
  if (
    hash(glue.replace(/\r\n/g, "\n")) !== manifest.glueSha256 ||
    hash(wasm) !== manifest.wasmSha256
  )
    throw Error("脚本引擎完整性校验失败");
  const factory = (await import(new URL("emscripten-module.js", assets).href))
    .default;
  let module;
  const engine = await newQuickJSWASMModuleFromVariant({
    type: "sync",
    importFFI: RELEASE_SYNC.importFFI,
    importModuleLoader: async () => async (options) => {
      module = await factory({ ...options, wasmBinary: wasm });
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
