import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  lstatSync,
  readdirSync,
  readlinkSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { UPSTREAM, EMSDK, hash } from "./catalog.mjs";

export const variant = "packages/variant-quickjs-wasmfile-release-sync";
export const receiptName = ".trusted-bytecode-build.json";
// Exact Linux x64 SDK distribution already obtained from official emsdk 3.1.65
// and used to reproduce the prerequisite engine. This experiment intentionally
// fails closed on another installation/cache snapshot until separately reviewed.
// A version string or a self-declared newly generated manifest is insufficient.
export const REVIEWED_SDK = Object.freeze({
  distributionSha256:
    "1d4987c1af39b5fa46dd17d1044ceb7f763ba65614248d1795cd6c4856d92cc5",
  nodeSha256:
    "563a678816281a08dc7da9fd3ece4e1fc5fcc01f68ffe404f6cdd1f715821b8f",
});
export function assertSdkDigests(distributionSha256, nodeSha256) {
  if (
    distributionSha256 !== REVIEWED_SDK.distributionSha256 ||
    nodeSha256 !== REVIEWED_SDK.nodeSha256
  )
    throw Error(
      "Installed SDK bytes differ from the reviewed compiler distribution",
    );
}
export const baseline = JSON.parse(
  readFileSync(
    new URL("../../src/vendor/quickjs-tracked/manifest.json", import.meta.url),
  ),
);
export const bridge = () =>
  readFileSync(new URL("./bridge.c", import.meta.url));
const git = (root, ...args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
const sorted = (value) =>
  JSON.stringify(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en")),
  );
const blobHash = (bytes) =>
  createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");

// Check actual files against the immutable HEAD tree, not the mutable index or
// git diff: assume-unchanged/skip-worktree must not hide an input modification.
export function verifyTrackedTree(root, commit, overrides = {}) {
  if (git(root, "rev-parse", "HEAD").trim() !== commit)
    throw Error("Unreviewed source revision");
  const inputs = {};
  const seen = new Set();
  for (const record of git(root, "ls-tree", "-rz", "--full-tree", "HEAD")
    .split("\0")
    .filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/s.exec(record);
    if (!match) {
      const gitlink = /^160000 commit ([a-f0-9]{40})\t(.+)$/s.exec(record);
      if (!gitlink) throw Error("Unsupported source tree entry");
      const [, digest, name] = gitlink;
      const linked = path.join(root, name);
      if (
        !lstatSync(linked).isDirectory() ||
        lstatSync(linked).isSymbolicLink() ||
        readdirSync(linked).length
      )
        throw Error(
          "Build must not initialize unused upstream submodules: " + name,
        );
      inputs[name] = hash("uninitialized gitlink:" + digest);
      seen.add(name);
      continue;
    }
    const [, , digest, name] = match;
    const bytes = readRegular(root, name);
    if (
      Object.hasOwn(overrides, name)
        ? hash(bytes) !== overrides[name]
        : blobHash(bytes) !== digest
    )
      throw Error("Unreviewed source input: " + name);
    inputs[name] = hash(bytes);
    seen.add(name);
  }
  for (const name of Object.keys(overrides))
    if (!seen.has(name)) throw Error("Missing reviewed source input: " + name);
  return inputs;
}

export function readRegular(root, name) {
  const parts = name.split("/");
  if (parts.some((x) => !x || x === "." || x === ".."))
    throw Error("Invalid build input path");
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const info = lstatSync(current);
    if (
      info.isSymbolicLink() ||
      (i < parts.length - 1 ? !info.isDirectory() : !info.isFile())
    )
      throw Error("Non-regular build input: " + name);
  }
  return readFileSync(current);
}

export function generatedInputs(source) {
  const symbols = [];
  for (const match of source
    .toString("utf8")
    .matchAll(/^([\w()* ]+[\s*]+)(QTS_\w+)\((.*?)\) ?\{/gm))
    if (!/AsyncifyOnly|DebugOnly/.test(match[1])) symbols.push("_" + match[2]);
  symbols.push("_malloc", "_free");
  return Object.fromEntries(
    [
      ["symbols.json", symbols],
      ["asyncify-remove.json", []],
      ["asyncify-imports.json", []],
    ].map(([name, value]) => [
      `${variant}/build/wrapper/${name}`,
      Buffer.from(JSON.stringify(value)),
    ]),
  );
}

export function writeGenerated(root) {
  for (const [name, bytes] of Object.entries(
    generatedInputs(readRegular(root, "c/interface.c")),
  )) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), bytes);
  }
}

export function verifySourceInputs(root) {
  if (
    baseline.sourceCommit !== UPSTREAM ||
    baseline.emsdkCommit !== EMSDK ||
    baseline.emscripten !== "3.1.65"
  )
    throw Error("Unreviewed baseline manifest");
  for (const [name, digest] of [
    ["rejection-tracker.patch", baseline.patchSha256],
    ["heap-accounting.patch", baseline.heapPatchSha256],
  ])
    if (
      hash(
        readFileSync(
          new URL("../../src/vendor/quickjs-tracked/" + name, import.meta.url),
        ),
      ) !== digest
    )
      throw Error("Unreviewed baseline patch: " + name);
  const source = readRegular(root, "c/interface.c");
  const suffix = Buffer.concat([Buffer.from("\n"), bridge()]);
  if (
    !source.subarray(-suffix.length).equals(suffix) ||
    hash(source.subarray(0, -suffix.length)) !== baseline.patchedSourceSha256
  )
    throw Error("Unreviewed bridge or base interface");
  const inputs = verifyTrackedTree(root, UPSTREAM, {
    "c/interface.c": hash(source),
    [`${variant}/Makefile`]: baseline.patchedMakefileSha256,
    "vendor/quickjs/quickjs.c": baseline.patchedQuickJSSourceSha256,
  });
  const generated = generatedInputs(source);
  for (const [name, bytes] of Object.entries(generated)) {
    if (!readRegular(root, name).equals(bytes))
      throw Error("Unreviewed generated build input: " + name);
    inputs[name] = hash(bytes);
  }
  // Include ignored files: a shadow header or stale object cannot be trusted
  // merely because an upstream .gitignore conceals it from normal git status.
  const extras = [
    ...git(root, "ls-files", "--others", "--exclude-standard", "-z").split(
      "\0",
    ),
    ...git(
      root,
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
    ).split("\0"),
  ].filter(Boolean);
  const outputs = new Set([
    receiptName,
    ...Object.keys(generated),
    `${variant}/build/wrapper/interface.o`,
    ...[
      "quickjs",
      "libregexp",
      "libunicode",
      "cutils",
      "quickjs-libc",
      "libbf",
    ].map((name) => `${variant}/build/quickjs/${name}.o`),
    `${variant}/dist/emscripten-module.wasm`,
    `${variant}/dist/emscripten-module.mjs`,
  ]);
  for (const name of extras) {
    if (!outputs.has(name)) throw Error("Unexpected build overlay: " + name);
    readRegular(root, name);
  }
  return {
    sourceCommit: UPSTREAM,
    sourceInputsSha256: hash(sorted(inputs)),
    bridgeSha256: hash(bridge()),
    interfaceBaseSha256: baseline.patchedSourceSha256,
    patchedSourceSha256: hash(source),
    patchedQuickJSSourceSha256: baseline.patchedQuickJSSourceSha256,
    patchedMakefileSha256: baseline.patchedMakefileSha256,
    baselinePatchSha256: baseline.patchSha256,
    heapPatchSha256: baseline.heapPatchSha256,
  };
}

function directoryDigest(root) {
  const inputs = {};
  const visit = (relative = "") => {
    for (const name of readdirSync(path.join(root, relative)).sort()) {
      // Python caches and the cache lock are not compiler inputs. Python bytecode
      // cannot be read/written under the impossible pycache prefix; the lock is coordination.
      if (name === "__pycache__" || name === ".emscripten_cache__lock")
        continue;
      const rel = relative ? `${relative}/${name}` : name;
      const info = lstatSync(path.join(root, rel));
      if (info.isDirectory()) visit(rel);
      else if (info.isSymbolicLink()) {
        const target = readlinkSync(path.join(root, rel));
        if (
          path.isAbsolute(target) ||
          path
            .relative(root, path.resolve(root, relative, target))
            .startsWith("..")
        )
          throw Error("SDK link escapes its fixed distribution: " + rel);
        inputs[rel] = "symlink:" + target;
      } else if (info.isFile())
        inputs[rel] = hash(readFileSync(path.join(root, rel)));
      else throw Error("Unsupported SDK input: " + rel);
    }
  };
  visit();
  return hash(sorted(inputs));
}

export function buildEnvironment(sdk) {
  return {
    PATH: "/usr/bin:/bin",
    HOME: process.env.HOME || "/tmp",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    EM_CONFIG: path.join(sdk, ".emscripten"),
    EM_FROZEN_CACHE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONPYCACHEPREFIX: "/dev/null/localapi-no-pycache",
  };
}

export function verifySdk(sdk) {
  if (process.platform !== "linux" || /\s/.test(sdk))
    throw Error(
      "This fixed experiment builder requires a Linux SDK path without whitespace",
    );
  const tracked = verifyTrackedTree(sdk, EMSDK);
  const releases = JSON.parse(
    readRegular(sdk, "emscripten-releases-tags.json"),
  );
  const release = releases.releases["3.1.65"];
  if (
    !release ||
    readRegular(sdk, "upstream/.emsdk_version").toString().trim() !==
      `releases-${release}-64bit` ||
    readRegular(sdk, "upstream/emscripten/emscripten-version.txt")
      .toString()
      .trim() !== '"3.1.65"'
  )
    throw Error("Installed SDK release identity mismatch");
  // Do not trust an executable Python config supplied via the ambient env.
  const config = readRegular(sdk, ".emscripten").toString();
  const expectedConfig =
    "import os\nemsdk_path = os.path.dirname(os.getenv('EM_CONFIG')).replace('\\\\', '/')\nNODE_JS = emsdk_path + '/node/18.20.3_64bit/bin/node'\nLLVM_ROOT = emsdk_path + '/upstream/bin'\nBINARYEN_ROOT = emsdk_path + '/upstream'\nEMSCRIPTEN_ROOT = emsdk_path + '/upstream/emscripten'\n";
  if (config !== expectedConfig) throw Error("Unreviewed SDK configuration");
  const distributionSha256 = directoryDigest(path.join(sdk, "upstream"));
  const nodeSha256 = hash(readRegular(sdk, "node/18.20.3_64bit/bin/node"));
  assertSdkDigests(distributionSha256, nodeSha256);
  const version = execFileSync(
    "/usr/bin/python3",
    [
      "-B",
      "-X",
      "pycache_prefix=/dev/null/localapi-no-pycache",
      path.join(sdk, "upstream/emscripten/emcc.py"),
      "--version",
    ],
    { env: buildEnvironment(sdk), encoding: "utf8" },
  );
  if (
    !version.startsWith(
      "emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 3.1.65 ",
    )
  )
    throw Error("Actual compiler version mismatch");
  return {
    emscripten: "3.1.65",
    emsdkCommit: EMSDK,
    sdkRelease: release,
    sdkTrackedSha256: hash(sorted(tracked)),
    sdkDistributionSha256: distributionSha256,
    sdkNodeSha256: nodeSha256,
    sdkConfigSha256: hash(config),
  };
}
