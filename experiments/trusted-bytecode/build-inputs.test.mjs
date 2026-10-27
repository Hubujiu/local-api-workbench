import test from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  verifyTrackedTree,
  readRegular,
  generatedInputs,
  REVIEWED_SDK,
  assertSdkDigests,
} from "./build-inputs.mjs";
import { hash } from "./catalog.mjs";
import {
  BASELINE_PATCH_FIELDS,
  BASELINE_SOURCE_FIELDS,
  readVerifiedBaseline,
  verifyBaselineInputs,
  verifyEngine,
} from "./integrity.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "localapi-build-input-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init");
  writeFileSync(path.join(root, "input.c"), "fixed input\n");
  git("add", "input.c");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "fixed fixture",
  );
  return { root, git, commit: git("rev-parse", "HEAD") };
}

test("input verification hashes immutable HEAD bytes, even if the index hides a change", (t) => {
  const { root, git, commit } = fixture(t);
  assert.equal(
    verifyTrackedTree(root, commit)["input.c"],
    hash("fixed input\n"),
  );
  git("update-index", "--assume-unchanged", "input.c");
  writeFileSync(path.join(root, "input.c"), "changed input\n");
  assert.equal(git("diff", "--name-only"), "");
  assert.throws(
    () => verifyTrackedTree(root, commit),
    /Unreviewed source input/,
  );
});

test("input verification accepts only the exact reviewed patch and revision", (t) => {
  const { root, commit } = fixture(t);
  writeFileSync(path.join(root, "input.c"), "reviewed patch\n");
  assert.equal(
    verifyTrackedTree(root, commit, { "input.c": hash("reviewed patch\n") })[
      "input.c"
    ],
    hash("reviewed patch\n"),
  );
  assert.throws(
    () => verifyTrackedTree(root, commit, { "input.c": hash("other patch\n") }),
    /Unreviewed source input/,
  );
  assert.throws(
    () => verifyTrackedTree(root, "0".repeat(40)),
    /Unreviewed source revision/,
  );
});

test("input verification rejects symlink replacements and path traversal", (t) => {
  const { root, commit } = fixture(t);
  writeFileSync(path.join(root, "replacement"), "fixed input\n");
  rmSync(path.join(root, "input.c"));
  symlinkSync("replacement", path.join(root, "input.c"));
  assert.throws(
    () => verifyTrackedTree(root, commit),
    /Non-regular build input/,
  );
  assert.throws(
    () => readRegular(root, "../replacement"),
    /Invalid build input path/,
  );
  mkdirSync(path.join(root, "real"));
  writeFileSync(path.join(root, "real", "header.h"), "header");
  symlinkSync("real", path.join(root, "shadow"));
  assert.throws(
    () => readRegular(root, "shadow/header.h"),
    /Non-regular build input/,
  );
});

test("generated export symbols are derived only from the reviewed C interface", () => {
  const inputs = generatedInputs(
    Buffer.from(
      "int QTS_Normal(int x) {\n}\nint QTS_Multiline(int x,\n  int y) {\n}\nDebugOnly int QTS_Hidden(int x) {\n}\n",
    ),
  );
  const symbols = JSON.parse(
    inputs[
      "packages/variant-quickjs-wasmfile-release-sync/build/wrapper/symbols.json"
    ],
  );
  assert.deepEqual(symbols, [
    "_QTS_Normal",
    "_QTS_Multiline",
    "_malloc",
    "_free",
  ]);
  assert.equal(
    inputs[
      "packages/variant-quickjs-wasmfile-release-sync/build/wrapper/asyncify-imports.json"
    ].toString(),
    "[]",
  );
});

test("fixed SDK identity rejects changed compiler or Node bytes before compiler invocation", () => {
  assert.doesNotThrow(() =>
    assertSdkDigests(REVIEWED_SDK.distributionSha256, REVIEWED_SDK.nodeSha256),
  );
  assert.throws(
    () => assertSdkDigests("0".repeat(64), REVIEWED_SDK.nodeSha256),
    /reviewed compiler distribution/,
  );
  assert.throws(
    () => assertSdkDigests(REVIEWED_SDK.distributionSha256, "0".repeat(64)),
    /reviewed compiler distribution/,
  );
});

function baselineFixture() {
  const base = new URL("../../src/vendor/quickjs-tracked/", import.meta.url);
  return {
    baseline: JSON.parse(readFileSync(new URL("manifest.json", base))),
    patches: Object.fromEntries(
      Object.keys(BASELINE_PATCH_FIELDS).map((name) => [
        name,
        readFileSync(new URL(name, base)),
      ]),
    ),
    wasm: Buffer.from(
      readFileSync(new URL("emscripten-module.wasm.b64", base), "utf8").trim(),
      "base64",
    ),
    glue: readFileSync(new URL("emscripten-module.js", base)),
  };
}

test("baseline provenance includes all six patched sources and four actual patches", () => {
  const { baseline, identity, sources } = readVerifiedBaseline();
  assert.deepEqual(Object.keys(sources), [
    "c/interface.c",
    "packages/variant-quickjs-wasmfile-release-sync/Makefile",
    "vendor/quickjs/quickjs.c",
    "vendor/quickjs/libregexp.c",
    "vendor/quickjs/libregexp.h",
    "vendor/quickjs/libunicode.c",
  ]);
  assert.deepEqual(Object.keys(BASELINE_PATCH_FIELDS), [
    "rejection-tracker.patch",
    "heap-accounting.patch",
    "regexp-interrupt.patch",
    "unicode-script-oom.patch",
  ]);
  for (const [name, field] of Object.entries(BASELINE_SOURCE_FIELDS))
    assert.equal(sources[name], baseline[field]);
  assert.equal(identity.baselineWasmSha256, baseline.wasmSha256);
  assert.equal(identity.baselineGlueSha256, baseline.glueSha256);
  assert.equal(
    identity.regexpInterruptSourceCommit,
    "25aaa7737020d7ca98926abc532acc6c5755d562",
  );
  assert.equal(
    identity.unicodeScriptOOMSourceCommit,
    "817509a87c3c0af362df576574784bae0dae8129",
  );
});

test("each baseline patch and production binary mismatch is rejected before any compiler or runtime", () => {
  const f = baselineFixture();
  assert.doesNotThrow(() =>
    verifyBaselineInputs(f.baseline, f.patches, f.wasm, f.glue),
  );
  for (const name of Object.keys(BASELINE_PATCH_FIELDS)) {
    const patches = {
      ...f.patches,
      [name]: Buffer.concat([f.patches[name], Buffer.from("\nchanged")]),
    };
    assert.throws(
      () => verifyBaselineInputs(f.baseline, patches, f.wasm, f.glue),
      /Unreviewed baseline patch/,
    );
  }
  for (const [wasm, glue] of [
    [f.wasm.subarray(0, -1), f.glue],
    [f.wasm, f.glue.subarray(0, -1)],
  ])
    assert.throws(
      () => verifyBaselineInputs(f.baseline, f.patches, wasm, glue),
      /production baseline artifact identity mismatch/,
    );
});

test("baseline requires reviewed upstream commits and all six source fingerprints", () => {
  const f = baselineFixture();
  for (const field of [
    "sourceRepository",
    "sourceCommit",
    "sourceTag",
    "emsdkCommit",
    "emscripten",
    "regexpInterruptSourceCommit",
    "unicodeScriptOOMSourceCommit",
    ...Object.values(BASELINE_SOURCE_FIELDS),
  ]) {
    const baseline = { ...f.baseline, [field]: "unreviewed" };
    assert.throws(
      () => verifyBaselineInputs(baseline, f.patches, f.wasm, f.glue),
      /Unreviewed fixed baseline identity/,
    );
  }
});

test("engine identity rejects well-formed substitutions for every added baseline provenance binding", () => {
  const assets = new URL("./artifacts/", import.meta.url);
  const identity = JSON.parse(readFileSync(new URL("engine.json", assets)));
  const wasm = Buffer.from(
    readFileSync(new URL("engine.wasm.b64", assets), "utf8").trim(),
    "base64",
  );
  const glue = readFileSync(new URL("engine.mjs", assets));
  const loader = readFileSync(new URL("./engine.mjs", import.meta.url));
  verifyEngine(identity, wasm, glue, loader);
  for (const field of [
    "baselineManifestSha256",
    "baselineWasmSha256",
    "baselineGlueSha256",
    "integrityVerifierSha256",
    "regexpInterruptPatchSha256",
    "unicodeScriptOOMPatchSha256",
    "patchedRegExpSourceSha256",
    "patchedRegExpHeaderSha256",
    "patchedUnicodeSourceSha256",
    "regexpInterruptSourceCommit",
    "unicodeScriptOOMSourceCommit",
  ]) {
    assert.throws(
      () =>
        verifyEngine(
          { ...identity, [field]: "0".repeat(identity[field].length) },
          wasm,
          glue,
          loader,
        ),
      /identity mismatch/,
    );
  }
});
