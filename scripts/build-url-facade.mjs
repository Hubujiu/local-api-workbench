import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const allowed = new Set([
  "src/script-url-facade.mjs",
  "src/script-url-runtime.mjs",
  "src/script-url-state.mjs",
  "src/vendor/url-sdk-host.js",
]);
const result = await build({
  entryPoints: ["src/script-url-facade.mjs"],
  bundle: true,
  format: "iife",
  globalName: "URLFacadeLibrary",
  platform: "neutral",
  target: "es2020",
  minify: true,
  write: false,
  metafile: true,
});
const inputs = Object.keys(result.metafile.inputs);
if (
  inputs.some((name) => !allowed.has(name)) ||
  Object.values(result.metafile.outputs).some((output) => output.imports.length)
)
  throw Error("Unreviewed URL facade dependency");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sourceHashes = {};
for (const name of inputs) sourceHashes[name] = hash(await readFile(name));
const output = result.outputFiles[0].contents;
await writeFile("src/vendor/url-sdk-facade.js", output);
await writeFile(
  "src/vendor/url-sdk-facade-manifest.json",
  JSON.stringify(
    { bytes: output.length, sha256: hash(output), sourceHashes },
    null,
    2,
  ) + "\n",
);
