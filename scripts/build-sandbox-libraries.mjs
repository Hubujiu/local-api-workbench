import { build, transform } from "esbuild";
import { draft7MetaPlugin } from "./precompile-schema-meta.mjs";
import { createHash } from "node:crypto";
import { quickJSURIRegex } from "./quickjs-uri-regex.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
await mkdir("src/vendor", { recursive: true });
await build({
  entryPoints: ["scripts/sandbox-library-entry.mjs"],
  outfile: "src/vendor/script-libraries.js",
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  external: ["crypto"],
  legalComments: "inline",
});
await build({
  entryPoints: ["scripts/sandbox-json5-entry.mjs"],
  outfile: "src/vendor/json5-library.js",
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  legalComments: "inline",
});
const notices = [];
for (const [file, expected] of [
  [
    "utils.js",
    "f97791a6c193027083b654d7428e0101aa2aaf5c2ab07a813cb8c1bf71d4ceb6",
  ],
  [
    "schemes.js",
    "c2c61d3fd0bc63a587100928a399e75be8c420d210c439d75f7346da4aa4f3c3",
  ],
]) {
  const bytes = await readFile("node_modules/fast-uri/lib/" + file);
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw Error(
      "fast-uri source changed; review QuickJS compatibility before rebuilding",
    );
}
const schemaBundle = await build({
  entryPoints: ["scripts/sandbox-schema-entry.mjs"],
  plugins: [draft7MetaPlugin()],
  write: false,
  bundle: true,
  minify: false,
  format: "iife",
  platform: "browser",
  target: "es2022",
  legalComments: "inline",
});
const schemaCode = await transform(
  quickJSURIRegex(schemaBundle.outputFiles[0].text),
  {
    minify: true,
    target: "es2022",
    legalComments: "inline",
  },
);
await writeFile("src/vendor/schema-library.js", schemaCode.code);
for (const name of [
  "crypto-js",
  "chai",
  "lodash",
  "moment",
  "uuid",
  "@xmldom/xmldom",
  "handlebars",
  "json5",
  "ajv",
  "ajv-formats",
  "fast-uri",
  "fast-deep-equal",
  "json-schema-traverse",
]) {
  const packageInfo = JSON.parse(
    await readFile("node_modules/" + name + "/package.json", "utf8"),
  );
  let text;
  for (const filename of ["LICENSE", "LICENSE.txt", "LICENSE.md"])
    try {
      text = await readFile("node_modules/" + name + "/" + filename, "utf8");
      break;
    } catch {}
  if (!text) throw Error("Missing license for " + name);
  notices.push(name + " " + packageInfo.version + "\n" + text);
}
await writeFile(
  "src/vendor/THIRD-PARTY-LICENSES.txt",
  notices.join("\n\n---\n\n"),
);

// Rebuild the reviewed, separately scoped URL adapter with the other trusted assets.
await import("./build-url-sdk.mjs");

// Rebuild the separately isolated, licensed original Mock core.
await import("./build-native-mock.mjs");
