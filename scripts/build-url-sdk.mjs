import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
const vendorRoot = "scripts/vendor/postman-url-sdk";
const manifest = JSON.parse(
  await readFile(vendorRoot + "/manifest.json", "utf8"),
);
for (const [name, expected] of Object.entries(manifest.files)) {
  if (!/^(?:lib\/[a-z/-]+\.js|LICENSE\.md)$/.test(name) || name.includes(".."))
    throw Error("Invalid reviewed SDK source path");
  const bytes = await readFile(vendorRoot + "/" + name);
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw Error("Reviewed SDK source changed: " + name);
}
const packageScope = JSON.parse(
  await readFile(vendorRoot + "/package.json", "utf8"),
);
if (
  packageScope.private !== true ||
  packageScope.type !== "commonjs" ||
  Object.keys(packageScope).length !== 2
)
  throw Error(
    "URL source package scope must not declare dependencies or scripts",
  );
const versions = {};
for (const [name, expected] of [
  ["lodash", "4.18.1"],
  ["postman-url-encoder", "3.0.8"],
]) {
  const info = JSON.parse(
    await readFile("node_modules/" + name + "/package.json", "utf8"),
  );
  if (info.version !== expected)
    throw Error("URL SDK dependency version changed: " + name);
  versions[name] = info.version;
}
const shims = {
  uuid: "module.exports=Object.freeze({v4(){throw Error('URL-only adapter does not generate IDs')}});",
  "iconv-lite":
    "module.exports=Object.freeze({encodingExists(){return false},decode(){throw Error('URL-only adapter does not decode buffers')}});",
  dynamic: "module.exports=Object.freeze({});",
};
const dependencies = {
  name: "reviewed-url-only-dependencies",
  setup(builder) {
    builder.onResolve({ filter: /^(uuid|iconv-lite)$/ }, (args) => ({
      path: args.path,
      namespace: "url-sdk-shim",
    }));
    builder.onResolve({ filter: /^\.\/dynamic-variables$/ }, (args) => {
      if (
        args.importer !== path.resolve(vendorRoot, "lib/superstring/index.js")
      )
        throw Error("Unexpected dynamic-variable dependency");
      return { path: "dynamic", namespace: "url-sdk-shim" };
    });
    builder.onResolve({ filter: /^lodash$/ }, () => ({
      path: path.resolve("node_modules/lodash/lodash.js"),
    }));
    builder.onResolve({ filter: /^postman-url-encoder\/parser$/ }, () => ({
      path: path.resolve("node_modules/postman-url-encoder/parser/index.js"),
    }));
    builder.onLoad({ filter: /.*/, namespace: "url-sdk-shim" }, (args) => ({
      contents: shims[args.path],
      loader: "js",
    }));
  },
};
await mkdir("src/vendor", { recursive: true });
const outputs = [];
for (const [format, filename] of [
  ["iife", "url-sdk.js"],
  ["esm", "url-sdk-host.js"],
]) {
  const result = await build({
    entryPoints: ["scripts/url-sdk-entry.cjs"],
    bundle: true,
    platform: "browser",
    format,
    ...(format === "iife" ? { globalName: "LocalURLSDK" } : {}),
    minify: true,
    write: false,
    metafile: true,
    legalComments: "inline",
    plugins: [dependencies],
  });
  const inputs = Object.keys(result.metafile.inputs).map((name) =>
    name.replaceAll("\\", "/"),
  );
  if (
    inputs.some(
      (name) =>
        !/^(?:scripts\/vendor\/postman-url-sdk\/lib\/[a-z/-]+\.js|scripts\/url-sdk-entry\.cjs|node_modules\/postman-url-encoder\/parser\/[a-z-]+\.js|node_modules\/lodash\/lodash\.js|url-sdk-shim:(?:uuid|iconv-lite|dynamic))$/.test(
          name,
        ),
    )
  )
    throw Error("Unreviewed URL SDK dependency graph");
  for (const input of inputs)
    if (
      input.startsWith(vendorRoot + "/") &&
      !Object.hasOwn(manifest.files, input.slice(vendorRoot.length + 1))
    )
      throw Error("Unhashed URL SDK source: " + input);
  if (
    Object.values(result.metafile.outputs).some(
      (output) => output.imports.length,
    )
  )
    throw Error("URL SDK has external imports");
  const code = result.outputFiles[0].text;
  await writeFile("src/vendor/" + filename, code);
  outputs.push({
    filename,
    bytes: Buffer.byteLength(code),
    sha256: createHash("sha256").update(code).digest("hex"),
    inputs,
  });
}
const licenses = [
  "Modified URL-only subset of postman-collection 5.3.1\n" +
    (await readFile(vendorRoot + "/LICENSE.md", "utf8")),
];
for (const name of Object.keys(versions)) {
  let license;
  for (const file of ["LICENSE", "LICENSE.md", "LICENSE.txt"]) {
    try {
      license = await readFile("node_modules/" + name + "/" + file, "utf8");
      break;
    } catch {}
  }
  if (!license) throw Error("Missing URL SDK license: " + name);
  licenses.push(name + " " + versions[name] + "\n" + license);
}
await writeFile(
  "src/vendor/URL-SDK-LICENSES.txt",
  licenses.join("\n\n---\n\n"),
);
await writeFile(
  "src/vendor/url-sdk-manifest.json",
  JSON.stringify(
    {
      source: manifest.package + "@" + manifest.version,
      versions,
      excluded: [
        "legacy faker",
        "legacy uuid",
        "iconv-lite",
        "default dynamic generators",
      ],
      outputs,
    },
    null,
    2,
  ) + "\n",
);

await import("./build-url-facade.mjs");
