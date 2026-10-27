import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const assets = new URL("../src/vendor/quickjs-tracked/", import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL("manifest.json", assets), "utf8"),
);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const [mode, directory] = process.argv.slice(2);
if (!["prepare", "verify"].includes(mode) || !directory)
  throw Error("Usage: node scripts/build-quickjs.mjs prepare|verify DIRECTORY");
if (
  manifest.sourceRepository !==
    "https://github.com/justjake/quickjs-emscripten" ||
  manifest.sourceCommit !== "235f6da2fd4f7354fa4765fde4aea880d2a4aef5"
)
  throw Error("Unapproved runtime source");
const root = path.resolve(directory),
  patch = fileURLToPath(new URL("rejection-tracker.patch", assets)),
  heapPatch = fileURLToPath(new URL("heap-accounting.patch", assets)),
  regexpPatch = fileURLToPath(new URL("regexp-interrupt.patch", assets));
if (
  hash((await readFile(patch, "utf8")).replace(/\r\n/g, "\n")) !==
  manifest.patchSha256
)
  throw Error("Runtime patch integrity mismatch");
if (
  hash((await readFile(heapPatch, "utf8")).replace(/\r\n/g, "\n")) !==
  manifest.heapPatchSha256
)
  throw Error("Heap accounting patch integrity mismatch");
if (
  manifest.regexpInterruptSourceCommit !==
    "25aaa7737020d7ca98926abc532acc6c5755d562" ||
  hash((await readFile(regexpPatch, "utf8")).replace(/\r\n/g, "\n")) !==
    manifest.regexpInterruptPatchSha256
)
  throw Error("RegExp interruption patch integrity mismatch");
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
if (mode === "prepare") {
  let exists = true;
  try {
    await access(root);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    exists = false;
  }
  if (exists) throw Error("Refusing to replace an existing source directory");
  await mkdir(path.dirname(root), { recursive: true });
  execFileSync(
    "git",
    [
      "clone",
      "--depth",
      "1",
      "--branch",
      manifest.sourceTag,
      manifest.sourceRepository,
      root,
    ],
    { stdio: "inherit" },
  );
  if (git("rev-parse", "HEAD") !== manifest.sourceCommit)
    throw Error("Runtime source revision mismatch");
  git("apply", "--check", patch);
  git("apply", patch);
  git("apply", "--check", heapPatch);
  git("apply", heapPatch);
  git("apply", "--check", regexpPatch);
  git("apply", regexpPatch);
  const expected = [
    "c/interface.c",
    "packages/variant-quickjs-wasmfile-release-sync/Makefile",
    "vendor/quickjs/quickjs.c",
    "vendor/quickjs/libregexp.c",
    "vendor/quickjs/libregexp.h",
  ];
  if (
    JSON.stringify(git("diff", "--name-only").split("\n").sort()) !==
    JSON.stringify(expected.sort())
  )
    throw Error("Unexpected runtime patch paths");
  const code = await readFile(path.join(root, "c/interface.c"), "utf8");
  if (hash(code) !== manifest.patchedSourceSha256)
    throw Error("Patched C source mismatch");
  await verifySource();
  const symbols = [];
  for (const match of code.matchAll(
    /^([\w()* ]+[\s*]+)(QTS_\w+)\((.*?)\) ?\{/gm,
  ))
    if (!/AsyncifyOnly|DebugOnly/.test(match[1])) symbols.push("_" + match[2]);
  symbols.push("_malloc", "_free");
  const wrapper = path.join(
    root,
    "packages/variant-quickjs-wasmfile-release-sync/build/wrapper",
  );
  await mkdir(wrapper, { recursive: true });
  for (const [name, value] of [
    ["symbols.json", symbols],
    ["asyncify-remove.json", []],
    ["asyncify-imports.json", []],
  ])
    await writeFile(path.join(wrapper, name), JSON.stringify(value));
  console.log("QUICKJS_SOURCE_PREPARED", manifest.sourceCommit, symbols.length);
} else {
  await verifySource();
  const dist = path.join(
    root,
    "packages/variant-quickjs-wasmfile-release-sync/dist",
  );
  const wasm = await readFile(path.join(dist, "emscripten-module.wasm"));
  const glue = (
    await readFile(path.join(dist, "emscripten-module.mjs"), "utf8")
  ).replace(/\r\n/g, "\n");
  if (hash(wasm) !== manifest.wasmSha256 || hash(glue) !== manifest.glueSha256)
    throw Error("Rebuilt runtime differs from bundled runtime");
  console.log("QUICKJS_REPRODUCIBLE_BUILD_PASS", manifest.wasmSha256);
}

async function verifySource() {
  const expected = {
    "c/interface.c": manifest.patchedSourceSha256,
    "packages/variant-quickjs-wasmfile-release-sync/Makefile":
      manifest.patchedMakefileSha256,
    "vendor/quickjs/quickjs.c": manifest.patchedQuickJSSourceSha256,
    "vendor/quickjs/libregexp.c": manifest.patchedRegExpSourceSha256,
    "vendor/quickjs/libregexp.h": manifest.patchedRegExpHeaderSha256,
  };
  if (
    git("rev-parse", "HEAD") !== manifest.sourceCommit ||
    JSON.stringify(git("diff", "HEAD", "--name-only").split("\n").sort()) !==
      JSON.stringify(Object.keys(expected).sort())
  )
    throw Error("Runtime source paths differ from the reviewed patches");
  for (const [name, digest] of Object.entries(expected))
    if (hash(await readFile(path.join(root, name))) !== digest)
      throw Error("Runtime source does not match reviewed patches: " + name);
}
