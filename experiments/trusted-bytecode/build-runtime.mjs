import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  rmSync,
  lstatSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ABI, UPSTREAM, hash } from "./catalog.mjs";
import {
  variant,
  receiptName,
  baseline,
  bridge,
  readRegular,
  writeGenerated,
  verifySourceInputs,
  verifySdk,
  buildEnvironment,
} from "./build-inputs.mjs";

const [mode, directory, sdkDirectory, ...extra] = process.argv.slice(2);
if (
  !["prepare", "build", "collect", "verify"].includes(mode) ||
  !directory ||
  extra.length ||
  (mode === "prepare" ? sdkDirectory : !sdkDirectory)
)
  throw Error(
    "Usage: build-runtime.mjs prepare SOURCE_DIRECTORY | build|collect|verify SOURCE_DIRECTORY SDK_DIRECTORY",
  );
const root = path.resolve(directory);
const sdk = sdkDirectory && path.resolve(sdkDirectory);
const here = fileURLToPath(new URL("./", import.meta.url));
const assets = path.join(here, "artifacts");
const receiptPath = path.join(root, receiptName);

if (mode === "prepare") {
  // Reuse the official pinned-source preparer and both reviewed patches. It
  // refuses an existing directory instead of silently replacing local work.
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
  const interfacePath = path.join(root, "c/interface.c");
  const source = readRegular(root, "c/interface.c");
  if (hash(source) !== baseline.patchedSourceSha256)
    throw Error("Unreviewed base C source");
  writeFileSync(
    interfacePath,
    Buffer.concat([source, Buffer.from("\n"), bridge()]),
  );
  writeGenerated(root);
  const inputs = verifySourceInputs(root);
  console.log("PRIVATE_BRIDGE_PREPARED", UPSTREAM, inputs.sourceInputsSha256);
} else {
  if (
    !lstatSync(root).isDirectory() ||
    lstatSync(root).isSymbolicLink() ||
    !lstatSync(sdk).isDirectory() ||
    lstatSync(sdk).isSymbolicLink()
  )
    throw Error("Build source and SDK must be real directories");
  const sourceInputs = verifySourceInputs(root);
  const sdkInputs = verifySdk(sdk);
  const recipe = {
    version: 1,
    builderSha256: hash(
      readFileSync(new URL("./build-runtime.mjs", import.meta.url)),
    ),
    inputVerifierSha256: hash(
      readFileSync(new URL("./build-inputs.mjs", import.meta.url)),
    ),
    makeArgs: [
      "-j1",
      "EMCC=/usr/bin/python3 -B -X pycache_prefix=/dev/null/localapi-no-pycache <verified-sdk>/upstream/emscripten/emcc.py",
      "dist/emscripten-module.mjs",
    ],
    environment: { ...buildEnvironment("<verified-sdk>"), HOME: "<host-home>" },
    makeSha256: hash(readFileSync("/usr/bin/make")),
    pythonSha256: hash(readFileSync("/usr/bin/python3")),
    shellSha256: hash(readFileSync("/bin/sh")),
  };
  const inputs = {
    abi: ABI,
    ...sourceInputs,
    ...sdkInputs,
    builderSha256: recipe.builderSha256,
    inputVerifierSha256: recipe.inputVerifierSha256,
    buildRecipeSha256: hash(
      Buffer.concat([
        readFileSync(new URL("./build-runtime.mjs", import.meta.url)),
        Buffer.from("\0"),
        readFileSync(new URL("./build-inputs.mjs", import.meta.url)),
      ]),
    ),
    executionRecipeSha256: hash(JSON.stringify(recipe)),
    loaderSha256: hash(readFileSync(new URL("./engine.mjs", import.meta.url))),
  };
  if (mode === "build") {
    // Source verification above has already rejected every unexpected overlay;
    // remove only the dedicated generated directories. No stale .o is reused.
    rmSync(receiptPath, { force: true });
    rmSync(path.join(root, variant, "build"), { recursive: true, force: true });
    rmSync(path.join(root, variant, "dist"), { recursive: true, force: true });
    writeGenerated(root);
    execFileSync(
      "/usr/bin/make",
      [
        "-j1",
        `EMCC=/usr/bin/python3 -B -X pycache_prefix=/dev/null/localapi-no-pycache ${path.join(sdk, "upstream/emscripten/emcc.py")}`,
        "dist/emscripten-module.mjs",
      ],
      {
        cwd: path.join(root, variant),
        env: buildEnvironment(sdk),
        stdio: "inherit",
      },
    );
    // Capture the real compiler distribution before AND after. A build that
    // changes source/toolchain inputs cannot publish a successful receipt.
    if (
      JSON.stringify(verifySourceInputs(root)) !==
        JSON.stringify(sourceInputs) ||
      JSON.stringify(verifySdk(sdk)) !== JSON.stringify(sdkInputs)
    )
      throw Error("Build inputs changed while compiling");
    const identity = { ...inputs, ...outputHashes() };
    writeFileSync(
      receiptPath,
      JSON.stringify({ identity, recipe }, null, 2) + "\n",
    );
    console.log("PRIVATE_ENGINE_BUILT", identity.wasmSha256);
  } else {
    const receipt = JSON.parse(readRegular(root, receiptName));
    const identity = { ...inputs, ...outputHashes() };
    if (
      JSON.stringify(receipt.identity) !== JSON.stringify(identity) ||
      JSON.stringify(receipt.recipe) !== JSON.stringify(recipe)
    )
      throw Error(
        "Build receipt does not match current verified inputs and output bytes; rebuild required",
      );
    if (mode === "collect") {
      mkdirSync(assets, { recursive: true });
      writeFileSync(
        path.join(assets, "engine.wasm.b64"),
        readRegular(root, `${variant}/dist/emscripten-module.wasm`).toString(
          "base64",
        ) + "\n",
      );
      writeFileSync(
        path.join(assets, "engine.mjs"),
        readRegular(root, `${variant}/dist/emscripten-module.mjs`),
      );
      writeFileSync(
        path.join(assets, "engine.json"),
        JSON.stringify(identity, null, 2) + "\n",
      );
      writeFileSync(
        path.join(assets, "build-receipt.json"),
        JSON.stringify(receipt, null, 2) + "\n",
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
      const expected = JSON.parse(
        readFileSync(path.join(assets, "engine.json")),
      );
      if (JSON.stringify(identity) !== JSON.stringify(expected))
        throw Error("Rebuilt private engine identity mismatch");
      console.log("PRIVATE_ENGINE_REPRODUCED", identity.wasmSha256);
    }
  }
}

function outputHashes() {
  return {
    wasmSha256: hash(
      readRegular(root, `${variant}/dist/emscripten-module.wasm`),
    ),
    glueSha256: hash(
      readRegular(root, `${variant}/dist/emscripten-module.mjs`),
    ),
  };
}
