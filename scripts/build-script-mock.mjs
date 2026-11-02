import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const pkg = JSON.parse(
  await readFile("node_modules/apipost-mock/package.json", "utf8"),
);
const source = await readFile("node_modules/apipost-mock/dist/index.js");
const sourceHash = createHash("sha256").update(source).digest("hex");
for (const [path, expected] of [
  [
    "node_modules/apipost-mock/LICENSE",
    "e58ec7ded6c9dfdb7b1ffde07ef8ec9fdb41632e6879d67e29953a08e499460d",
  ],
  [
    "src/vendor/APIPOST-MOCK-LICENSE.txt",
    "e58ec7ded6c9dfdb7b1ffde07ef8ec9fdb41632e6879d67e29953a08e499460d",
  ],
  [
    "src/vendor/MOCKJS-UPSTREAM-LICENSE.txt",
    "bd806a192a544341aac761d7f4925446fc8dfd975f191048386b2da0571ffdc9",
  ],
]) {
  if (
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex") !== expected
  )
    throw Error("Review script Mock license notices before rebuilding");
}
if (
  pkg.version !== "1.0.2" ||
  pkg.license !== "MIT" ||
  pkg.dependencies ||
  sourceHash !==
    "444c7ccad3c4ee00ce6871517995852d5a5928715a6b449d3f2622291e6e816a"
)
  throw Error(
    "Review script Mock package source/version/license before rebuilding",
  );
const result = await build({
  entryPoints: ["scripts/script-mock-entry.mjs"],
  bundle: true,
  // Keep the logical package input path stable for reviewed local dependency
  // links and ordinary npm ci directories alike; package bytes are pinned.
  preserveSymlinks: true,
  minify: true,
  format: "iife",
  globalName: "ScriptMockLibrary",
  platform: "browser",
  target: "es2022",
  legalComments: "inline",
  metafile: true,
  write: false,
});
const inputs = Object.keys(result.metafile.inputs).sort();
if (
  JSON.stringify(inputs) !==
  JSON.stringify([
    "node_modules/apipost-mock/dist/index.js",
    "scripts/script-mock-entry.mjs",
    "src/script-mock-template.mjs",
  ])
)
  throw Error("Unexpected script Mock bundle dependency");
const code = result.outputFiles[0].text;
await writeFile("src/vendor/script-mock-library.js", code);
await writeFile(
  "src/vendor/script-mock-library.json",
  JSON.stringify(
    {
      package: "apipost-mock",
      version: pkg.version,
      sourceSha256: sourceHash,
      sha256: createHash("sha256").update(code).digest("hex"),
      inputs,
    },
    null,
    2,
  ) + "\n",
);
// Existing APIPOST-MOCK-LICENSE.txt is retained by its original builder. The
// pinned upstream notice is a reviewed source file, not fetched by this build.
