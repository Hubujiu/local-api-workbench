import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { compileTrackedQuickJS } from "../src/tracked-quickjs.mjs";
import { runScript } from "../src/scripts.mjs";

const compiled = await compileTrackedQuickJS();
function boundedWorker(source) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./fixtures/quickjs-regexp-worker.mjs", import.meta.url),
      {
        workerData: { source, compiled },
        resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 2 },
      },
    );
    let settled = false;
    const finish = async (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await worker.terminate();
      if (error) reject(error);
      else resolve(result);
    };
    // This is a failure guard, never accepted as successful regex interruption.
    const timer = setTimeout(
      () => finish(Error("regex worker exceeded unchanged 2s wall guard")),
      2000,
    );
    worker.once("error", (error) => finish(error));
    worker.once("message", (result) => finish(undefined, result));
    worker.once("exit", (code) => {
      if (!settled)
        finish(Error("regex worker exited without evidence: " + code));
    });
  });
}

test("reviewed regexp patch identity and manifest source digest fields are consistent", async () => {
  const root = new URL("../src/vendor/quickjs-tracked/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("manifest.json", root)));
  assert.equal(
    manifest.regexpInterruptSourceCommit,
    "25aaa7737020d7ca98926abc532acc6c5755d562",
  );
  const patch = (
    await readFile(new URL("regexp-interrupt.patch", root), "utf8")
  ).replace(/\r\n/g, "\n");
  assert.equal(
    createHash("sha256").update(patch).digest("hex"),
    manifest.regexpInterruptPatchSha256,
  );
  for (const key of ["patchedRegExpSourceSha256", "patchedRegExpHeaderSha256"])
    assert.match(manifest[key], /^[a-f0-9]{64}$/);
  assert.equal(manifest.emscripten, "3.1.65");
});

test("reviewed upstream Unicode Script OOM repair is the separate one-line patch", async () => {
  const root = new URL("../src/vendor/quickjs-tracked/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("manifest.json", root)));
  assert.equal(
    manifest.unicodeScriptOOMSourceCommit,
    "817509a87c3c0af362df576574784bae0dae8129",
  );
  const patch = (
    await readFile(new URL("unicode-script-oom.patch", root), "utf8")
  ).replace(/\r\n/g, "\n");
  assert.equal(
    createHash("sha256").update(patch).digest("hex"),
    manifest.unicodeScriptOOMPatchSha256,
  );
  assert.deepEqual(
    patch.split("\n").filter((line) => /^[+-](?![+-])/.test(line)),
    ["-    goto fail;", "+    return -1;"],
  );
  assert.equal(
    manifest.patchedUnicodeSourceSha256,
    "b151067a56841a0812d1087f02d2b9fe5ccc0dcf1f39a251f202d8ad34c03172",
  );
});

test("ordinary regex keeps no-flags UTF-16, coercion, lookaround and backreference behavior", async () => {
  const cases = [
    ["^.$", "😀"],
    ["^..$", "😀"],
    ["^.$", "\r"],
    ["^.$", "\n"],
    ["^.$", "\u2028"],
    ["^.$", "\u2029"],
    ["^a$", "a\n"],
    ["^a$", "a"],
    ["^\\s$", "\v"],
    ["^\\s$", "\u00a0"],
    ["^(a+)\\1$", "aaaa"],
    ["a(?=b)", "ab"],
    ["(?<=a)b", "ab"],
    ["abc/i", "ABC"],
    ["abc/i", "abc/i"],
    ["", "anything"],
    ["^null$", null],
    ["^undefined$", undefined],
    ["^false$", false],
    ["^42$", 42],
  ];
  // Encode undefined explicitly; all patterns are small, valid, authored inputs.
  const source = `[${cases
    .map(
      ([pattern, value]) =>
        `[${JSON.stringify(pattern)},${JSON.stringify(value)}]`,
    )
    .join(",")}].map(([pattern,value])=>new RegExp(pattern).test(value))`;
  const result = await boundedWorker(source);
  assert.equal(result.error, false, JSON.stringify(result));
  assert.deepEqual(
    result.value,
    cases.map(([pattern, value]) => new RegExp(pattern).test(value)),
  );
  assert.equal(result.expiredChecks, 0);
  assert(result.elapsedMs <= 250, JSON.stringify(result));
  assert.equal(result.unhandledAfterDispose, 0);
});

for (const [name, operation] of [
  ["exec and nested simple-greedy backtracking", "/(a+)+$/.exec(subject)"],
  ["global empty replacement fast path", "subject.replace(/(a+)+$/g, '')"],
  [
    "alternation and counted-loop backtracking",
    "/^(a|aa){1,100}$/.test(subject)",
  ],
]) {
  test(`regex C interruption is uncatchable and cleans up: ${name}`, async () => {
    const result = await boundedWorker(`
      globalThis.caught = false;
      globalThis.after = false;
      const subject = 'a'.repeat(64) + '!';
      try { ${operation}; } catch (error) { caught = true; }
      after = true;
    `);
    assert.equal(result.error, true, JSON.stringify(result));
    assert.equal(result.value.name, "InternalError");
    assert.equal(result.value.message, "interrupted");
    assert(result.expiredChecks > 0, JSON.stringify(result));
    assert.equal(result.caught, false);
    assert.equal(result.after, false);
    assert.equal(result.unhandledAfterDispose, 0);
    // Polling is cooperative; no exact millisecond overshoot claim is made.
    // A new runtime has no poison, escaped exception or reused user globals.
    const recovered = await boundedWorker(
      "[typeof caught, /^(a+)b$/.exec('aaab')[1]]",
    );
    assert.equal(recovered.error, false, JSON.stringify(recovered));
    assert.deepEqual(recovered.value, ["undefined", "aaa"]);
  });
}

test("production regex work after prior activity fails within the script stage, not parent wall timeout", async () => {
  await assert.rejects(
    runScript(
      "const start=Date.now();while(Date.now()-start<100){};/(a+)+$/.test('a'.repeat(64)+'!');",
      { request: { url: "http://localhost/" }, variables: {} },
    ),
    (error) => {
      assert.equal(error.message, "脚本执行超时");
      assert.equal(error.scriptStage, "script");
      assert.equal(error.activityOperation, "promise-state");
      assert.equal(error.scriptDiagnostics.activityBudgetMs, 250);
      return true;
    },
  );
});

test("regex stack OOM remains catchable and frees capacity without becoming timeout", async () => {
  const result = await boundedWorker(`
    let held = Array.from({length:15}, () => new ArrayBuffer(1024*1024));
    let message = '';
    try { /^(a)*$/.test('a'.repeat(32768)); }
    catch (error) { message = error.message; }
    held = [];
    [message, new ArrayBuffer(1024*1024).byteLength, /^ok$/.test('ok')];
  `);
  assert.equal(result.error, false, JSON.stringify(result));
  assert.match(result.value[0], /out of memory in regexp execution/);
  assert.deepEqual(result.value.slice(1), [1024 * 1024, true]);
  assert.equal(result.expiredChecks, 0);
  assert(result.elapsedMs <= 250, JSON.stringify(result));
  assert.equal(result.unhandledAfterDispose, 0);
});
