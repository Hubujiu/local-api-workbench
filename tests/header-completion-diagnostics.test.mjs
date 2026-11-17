import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { diagnoseHeaderCompletion } from "./helpers/header-completion-diagnostics.mjs";

test("header diagnostics preserve assertions, bound output and exclude private data", async () => {
  const error = Object.assign(Error("SECRET"), {
    scriptStage: "script",
    elapsedMs: 3,
    source: "SECRET",
  });
  let failure;
  const lines = [];
  await assert.rejects(
    diagnoseHeaderCompletion(
      2,
      async (capture) => {
        try {
          await assert.rejects(
            Promise.reject(error).catch(capture),
            /expected/,
          );
        } catch (e) {
          failure = e;
          throw e;
        }
      },
      (line) => lines.push(line),
    ),
    (e) => e === failure,
  );
  assert.equal(lines.length, 1);
  assert.ok(Buffer.byteLength(lines[0]) <= 2304);
  assert.ok(!lines[0].includes("SECRET"));
  assert.equal(JSON.parse(lines[0].split(" ").slice(1).join(" ")).caseIndex, 2);
  await diagnoseHeaderCompletion(
    0,
    (capture) => assert.rejects(Promise.reject(error).catch(capture), /SECRET/),
    () => assert.fail("successful assertion must be silent"),
  );
  await assert.rejects(
    diagnoseHeaderCompletion(
      0,
      () => {
        throw failure;
      },
      () => {
        throw Error("observer");
      },
    ),
    (e) => e === failure,
  );
});

test("header diagnostics reach actual spec and TAP reporters while preserving failing exit", () => {
  const helper = new URL(
    "./helpers/header-completion-diagnostics.mjs",
    import.meta.url,
  ).href;
  const source = `import test from 'node:test'; import assert from 'node:assert/strict'; import {diagnoseHeaderCompletion} from ${JSON.stringify(helper)};
  test('fixture', async t => diagnoseHeaderCompletion(1, capture => assert.rejects(Promise.reject(Object.assign(Error('other'), {scriptStage:'bootstrap', secret:'PRIVATE_SENTINEL'})).catch(capture), /expected/), line=>t.diagnostic(line)));`;
  for (const reporter of ["spec", "tap"]) {
    const child = spawnSync(
      process.execPath,
      ["--test-reporter=" + reporter, "--input-type=module", "-e", source],
      { encoding: "utf8", timeout: 10000, maxBuffer: 65536 },
    );
    assert.equal(child.status, 1);
    assert.match(child.stdout + child.stderr, /HEADER_COMPLETION_DIAGNOSTIC/);
    assert.doesNotMatch(child.stdout + child.stderr, /PRIVATE_SENTINEL/);
  }
});
