import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const versions = {},
  licenses = [];
for (const [name, version] of [
  ["@xmldom/xmldom", "0.9.12"],
  ["xpath", "0.0.35"],
]) {
  const info = JSON.parse(
    await readFile(`node_modules/${name}/package.json`, "utf8"),
  );
  if (info.version !== version || info.license !== "MIT")
    throw Error(
      "Review native XML dependency version/license before rebuilding: " + name,
    );
  versions[name] = version;
  licenses.push(
    name +
      " " +
      version +
      "\n" +
      (await readFile(`node_modules/${name}/LICENSE`, "utf8")),
  );
}
const result = await build({
  entryPoints: ["scripts/sandbox-native-xml-entry.mjs"],
  bundle: true,
  preserveSymlinks: true,
  minify: true,
  platform: "browser",
  format: "iife",
  globalName: "NativeXMLLibrary",
  target: "es2022",
  legalComments: "inline",
  write: false,
  metafile: true,
});
const sources = {};
for (const file of Object.keys(result.metafile.inputs).sort()) {
  if (
    !/^(?:scripts\/sandbox-(?:native-xml-entry|intrinsic-guard)\.mjs|src\/native-xml-path\.mjs|node_modules\/(?:@xmldom\/xmldom\/lib\/[a-z-]+\.js|xpath\/xpath\.js))$/.test(
      file,
    )
  )
    throw Error("Unreviewed native XML dependency: " + file);
  sources[file] = createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}
const code = result.outputFiles[0].text;
const artifacts = {
  "src/vendor/native-xml-library.js": code,
  "src/vendor/native-xml-library.json":
    JSON.stringify(
      {
        versions,
        sources,
        sha256: createHash("sha256").update(code).digest("hex"),
      },
      null,
      2,
    ) + "\n",
  "src/vendor/NATIVE-XML-LICENSES.txt": licenses.join("\n\n---\n\n"),
};
for (const [filename, contents] of Object.entries(artifacts)) {
  if (process.argv.includes("--check")) {
    if ((await readFile(filename, "utf8")) !== contents)
      throw Error("Native XML generated artifact differs: " + filename);
  } else await writeFile(filename, contents);
}
