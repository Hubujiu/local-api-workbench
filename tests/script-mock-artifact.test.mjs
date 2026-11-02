import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readScriptMockAsset } from "../src/script-mock-asset.mjs";

const source = (path) =>
  readFile(new URL("../" + path, import.meta.url), "utf8");
const hash = (value) => createHash("sha256").update(value).digest("hex");

test("script Mock artifact retains exact reviewed source, input graph and both MIT notices", async () => {
  const code = await readScriptMockAsset();
  const manifest = JSON.parse(
    await source("src/vendor/script-mock-library.json"),
  );
  assert.equal(manifest.package, "apipost-mock");
  assert.equal(manifest.version, "1.0.2");
  assert.equal(
    manifest.sourceSha256,
    "444c7ccad3c4ee00ce6871517995852d5a5928715a6b449d3f2622291e6e816a",
  );
  assert.equal(manifest.sha256, hash(code));
  assert.deepEqual(manifest.inputs, [
    "node_modules/apipost-mock/dist/index.js",
    "scripts/script-mock-entry.mjs",
    "src/script-mock-template.mjs",
  ]);
  for (const [path, digest] of [
    [
      "src/vendor/APIPOST-MOCK-LICENSE.txt",
      "e58ec7ded6c9dfdb7b1ffde07ef8ec9fdb41632e6879d67e29953a08e499460d",
    ],
    [
      "src/vendor/MOCKJS-UPSTREAM-LICENSE.txt",
      "bd806a192a544341aac761d7f4925446fc8dfd975f191048386b2da0571ffdc9",
    ],
    [
      "src/vendor/native-mock-library.js",
      "7d230c9780ac69e6a5ded3e65fa8b5aa7beefa3f43f76414c2921e24395c7850",
    ],
    [
      "src/vendor/native-mock-library.json",
      "d5025f088f526d300b4626e54232d40f9fa5885fcbea61ade37494d857d0cdd3",
    ],
  ])
    assert.equal(hash(await source(path)), digest, path);
  const attributes = await source(".gitattributes");
  for (const path of [
    "script-mock-library.js",
    "script-mock-library.json",
    "MOCKJS-UPSTREAM-LICENSE.txt",
  ])
    assert(
      attributes.split(/\r?\n/).includes("/src/vendor/" + path + " -text"),
    );
});

test("script Mock source wiring charges read and eager install inside the existing activity envelope", async () => {
  // This is source evidence, not a runtime interruption/performance proof.
  const worker = (await source("src/script-worker.mjs")).replaceAll(
    "\r\n",
    "\n",
  );
  assert.match(
    worker,
    /mockReadStarted = monotonicNow\(\);\s+const mockLibrary = await readScriptMockAsset\(\);\s+const mockLoadMs = monotonicNow\(\) - mockReadStarted;/,
  );
  assert.match(
    worker,
    /deadline = monotonicNow\(\) \+ workerData\.activityBudgetMs;\s+deadline -= mockLoadMs;/,
  );
  const stage = worker.indexOf('scriptStage = "compatibility";');
  const charged = worker.indexOf(
    'measureActivity("compatibility", "compatibilityMs", () => {',
    stage,
  );
  const install = worker.indexOf(
    "return ScriptMockLibrary.install(reserve);",
    charged,
  );
  const userScript = worker.indexOf('scriptStage = "script";', install);
  assert(
    stage >= 0 && charged > stage && install > charged && userScript > install,
  );
  assert(worker.includes("delete globalThis.__scriptMockReserve;"));
  assert(worker.includes("...mockBudget.usage()"));
  const scripts = await source("src/scripts.mjs");
  for (const key of ["mockCalls", "mockNodes", "mockBytes"])
    assert(scripts.includes("result.usage." + key));
  assert(scripts.includes("validateScriptMockUsage(result.usage"));
});
