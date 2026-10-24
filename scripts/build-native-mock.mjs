import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const pkg = JSON.parse(
  await readFile("node_modules/apipost-mock/package.json", "utf8"),
);
if (pkg.version !== "1.0.2" || pkg.license !== "MIT")
  throw Error(
    "Review native Mock dependency version/license before rebuilding",
  );
const result = await build({
  stdin: {
    contents:
      'import Mock from "apipost-mock"; globalThis.__nativeMockRandom=Mock.Random;',
    resolveDir: process.cwd(),
  },
  bundle: true,
  minify: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  legalComments: "inline",
  write: false,
});
const code = result.outputFiles[0].text;
await writeFile("src/vendor/native-mock-library.js", code);
await writeFile(
  "src/vendor/native-mock-library.json",
  JSON.stringify(
    {
      package: "apipost-mock",
      version: pkg.version,
      sha256: createHash("sha256").update(code).digest("hex"),
    },
    null,
    2,
  ) + "\n",
);
await writeFile(
  "src/vendor/APIPOST-MOCK-LICENSE.txt",
  await readFile("node_modules/apipost-mock/LICENSE"),
);
