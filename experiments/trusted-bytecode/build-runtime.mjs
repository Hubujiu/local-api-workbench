import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ABI, UPSTREAM, EMSDK, hash } from "./catalog.mjs";

const [mode, directory] = process.argv.slice(2);
if (!["prepare", "collect", "verify"].includes(mode) || !directory)
  throw Error(
    "Usage: build-runtime.mjs prepare|collect|verify SOURCE_DIRECTORY",
  );
const root = path.resolve(directory);
const here = fileURLToPath(new URL("./", import.meta.url));
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const baseline = JSON.parse(
  readFileSync(
    new URL("../../src/vendor/quickjs-tracked/manifest.json", import.meta.url),
  ),
);
const bridge = readFileSync(new URL("./bridge.c", import.meta.url));
const interfacePath = path.join(root, "c/interface.c");
if (mode === "prepare") {
  // Existing source preparation is deliberately reused, with the same official
  // pinned source and existing rejection tracker. It refuses an existing dir.
  execFileSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../scripts/build-quickjs.mjs", import.meta.url),
      ),
      "prepare",
      root,
    ],
    { stdio: "inherit" },
  );
  const source = readFileSync(interfacePath);
  if (hash(source) !== baseline.patchedSourceSha256)
    throw Error("Unreviewed base C source");
  writeFileSync(
    interfacePath,
    Buffer.concat([source, Buffer.from("\n"), bridge]),
  );
  const symbols = [];
  for (const match of readFileSync(interfacePath, "utf8").matchAll(
    /^([\w()* ]+[\s*]+)(QTS_\w+)\((.*?)\) ?\{/gm,
  ))
    if (!/AsyncifyOnly|DebugOnly/.test(match[1])) symbols.push("_" + match[2]);
  symbols.push("_malloc", "_free");
  writeFileSync(
    path.join(
      root,
      "packages/variant-quickjs-wasmfile-release-sync/build/wrapper/symbols.json",
    ),
    JSON.stringify(symbols),
  );
  console.log("PRIVATE_BRIDGE_PREPARED", UPSTREAM, symbols.length);
} else {
  if (git("rev-parse", "HEAD") !== UPSTREAM)
    throw Error("Unreviewed engine revision");
  const source = readFileSync(interfacePath);
  const suffix = Buffer.concat([Buffer.from("\n"), bridge]);
  if (
    !source.subarray(-suffix.length).equals(suffix) ||
    hash(source.subarray(0, -suffix.length)) !== baseline.patchedSourceSha256
  )
    throw Error("Unreviewed C source");
  const dist = path.join(
    root,
    "packages/variant-quickjs-wasmfile-release-sync/dist",
  );
  const wasm = readFileSync(path.join(dist, "emscripten-module.wasm"));
  const glue = readFileSync(path.join(dist, "emscripten-module.mjs"));
  const identity = {
    abi: ABI,
    sourceCommit: UPSTREAM,
    emscripten: "3.1.65",
    emsdkCommit: EMSDK,
    bridgeSha256: hash(bridge),
    patchedSourceSha256: hash(source),
    wasmSha256: hash(wasm),
    glueSha256: hash(glue),
    loaderSha256: hash(readFileSync(new URL("./engine.mjs", import.meta.url))),
    baselinePatchSha256: baseline.patchSha256,
  };
  const assets = path.join(here, "artifacts");
  if (mode === "collect") {
    mkdirSync(assets, { recursive: true });
    writeFileSync(
      path.join(assets, "engine.wasm.b64"),
      wasm.toString("base64") + "\n",
    );
    writeFileSync(path.join(assets, "engine.mjs"), glue);
    writeFileSync(
      path.join(assets, "engine.json"),
      JSON.stringify(identity, null, 2) + "\n",
    );
    copyFileSync(
      fileURLToPath(
        new URL("../../src/vendor/quickjs-tracked/LICENSE", import.meta.url),
      ),
      path.join(assets, "ENGINE-LICENSE.txt"),
    );
    copyFileSync(
      fileURLToPath(
        new URL("../../src/vendor/THIRD-PARTY-LICENSES.txt", import.meta.url),
      ),
      path.join(assets, "BUNDLE-LICENSES.txt"),
    );
    console.log("PRIVATE_ENGINE_COLLECTED", identity.wasmSha256);
  } else {
    const expected = JSON.parse(readFileSync(path.join(assets, "engine.json")));
    if (JSON.stringify(identity) !== JSON.stringify(expected))
      throw Error("Rebuilt private engine identity mismatch");
    console.log("PRIVATE_ENGINE_REPRODUCED", identity.wasmSha256);
  }
}
