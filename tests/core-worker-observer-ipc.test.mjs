import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  mkdtemp,
  mkdir,
  copyFile,
  writeFile,
  readFile,
  rm,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import {
  MAX_OBSERVER_PACKETS,
  MAX_PACKET_BYTES,
} from "../scripts/core-worker-observations.mjs";

const source = fileURLToPath(new URL("../scripts/", import.meta.url));
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
delete env.NODE_OPTIONS;
async function fixture(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "core-observer-ipc-"));
  await mkdir(path.join(cwd, "tests"));
  await mkdir(path.join(cwd, "scripts"));
  for (const name of [
    "run-core-tests.mjs",
    "core-test-allocation.mjs",
    "core-test-weights.json",
    "core-progress-reporter.mjs",
    "core-worker-observations.mjs",
    "core-worker-observer-preload.mjs",
  ])
    await copyFile(path.join(source, name), path.join(cwd, "scripts", name));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}
function invoke(cwd, args, environment = env) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    timeout: 15000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
}
async function run(cwd, expectedStatus) {
  const result = invoke(cwd, [
    "scripts/run-core-tests.mjs",
    "--shard=1/1",
    "--label=fixture",
  ]);
  assert.equal(result.status, expectedStatus, result.stdout + result.stderr);
  const prefix = path.join(cwd, "test-results/core-fixture-shard-1-of-1");
  const jsonl = await readFile(prefix + ".progress.jsonl", "utf8");
  assert(!jsonl.includes("DO_NOT_COPY"));
  assert(!jsonl.includes(cwd));
  const rows = jsonl
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return { result, rows, tap: await readFile(prefix + ".tap", "utf8") };
}
const imports =
  "import test from 'node:test';\nimport assert from 'node:assert/strict';\n";
const worker = `function worker(stage='bootstrap', elapsedMs=123) {
  return Object.assign(Error('DO_NOT_COPY_MESSAGE_interrupted'), {
    scriptStage:stage, elapsedMs, lastWorkerStage:stage, activityOperation:'bootstrap',
    scriptDiagnostics:{activityBudgetMs:250,bootstrapOperation:'input-transfer',bootstrapElapsedMs:18,bootstrapCPUUs:4100,secret:'DO_NOT_COPY_DIAGNOSTIC'},
    activityMetrics:{userScriptMs:7},activityCPUTimeUs:{userScriptUs:4200},
    body:'DO_NOT_COPY_BODY',sql:'DO_NOT_COPY_SQL',params:['DO_NOT_COPY_PARAMS'],
  });
}\n`;

test("core launcher captures pre-IPC worker observations without changing regex failure or success", async (t) => {
  const cwd = await fixture(t);
  const code =
    imports +
    worker +
    `
test('original regex failure', async () => {
  const original=worker(), message=original.message, name=original.name;
  try { await assert.rejects(Promise.reject(original), /XML/); }
  catch (failure) { assert.equal(failure.actual,original);assert.equal(original.message,message);assert.equal(original.name,name);throw failure; }
});
test('matching rejection stays passed', async () => { await assert.rejects(Promise.reject(worker()), /interrupted/); });
test('failure without worker metadata', async () => { await assert.rejects(Promise.reject(Error('plain')), /XML/); });
`;
  await writeFile(path.join(cwd, "tests/fixture.test.mjs"), code);
  const { rows, tap } = await run(cwd, 1);
  const observations = rows.filter((row) => row.type === "test:diagnostic");
  assert.equal(observations.length, 2);
  assert(
    observations.every(
      (row) =>
        row.file === "tests/fixture.test.mjs" &&
        row.status === "unknown" &&
        row.name === undefined,
    ),
  );
  const observed = observations.find(
    (row) => row.workerObservation.availability === "observed",
  );
  assert.equal(
    observed.line,
    code
      .split("\n")
      .findIndex((line) => line.startsWith("test('original regex failure'")) +
      1,
  );
  assert.equal(observed.workerObservation.workers[0].scriptStage, "bootstrap");
  assert.equal(
    observed.workerObservation.workers[0].scriptDiagnostics.bootstrapCPUUs,
    4100,
  );
  assert.equal(
    observed.workerObservation.workers[0].activityCPUTimeUs.userScriptUs,
    4200,
  );
  assert(
    observations.some(
      (row) => row.workerObservation.availability === "unavailable",
    ),
  );
  assert(
    rows.some(
      (row) =>
        row.type === "test:complete" &&
        row.name === "original regex failure" &&
        row.status === "failed",
    ),
  );
  assert(
    rows.some(
      (row) =>
        row.type === "test:complete" &&
        row.name === "matching rejection stays passed" &&
        row.status === "passed",
    ),
  );
  assert.equal(rows.at(-1).status, "failed");
  assert.match(tap, /# pass 1\n/);
  assert.match(tap, /# fail 2\n/);
  assert.match(tap, /The input did not match the regular expression \/XML\//);
  assert.match(tap, /CORE_WORKER_OBSERVATION_V1/);
});

test("nested concurrent observations retain actual declaration location without guessed case identity", async (t) => {
  const cwd = await fixture(t);
  const code =
    imports +
    worker +
    `
test('concurrent parent', {concurrency:2}, async (context) => {
  let entered=0, release;const ready=new Promise(resolve=>{release=resolve;});
  await Promise.all([11,22].map(value=>context.test('same name', async()=>{entered++;if(entered===2)release();await ready;await assert.rejects(Promise.reject(worker('script',value)),/XML/);})));
});
`;
  await writeFile(path.join(cwd, "tests/nested.test.mjs"), code);
  const { rows, tap } = await run(cwd, 1);
  const observed = rows.filter(
    (row) => row.workerObservation?.availability === "observed",
  );
  assert.equal(observed.length, 2);
  assert(
    observed.every(
      (row) =>
        row.name === undefined &&
        row.file === "tests/nested.test.mjs" &&
        row.nesting === 1,
    ),
  );
  assert.equal(observed[0].line, observed[1].line);
  assert.deepEqual(
    observed
      .map((row) => row.workerObservation.workers[0].elapsedMs)
      .sort((a, b) => a - b),
    [11, 22],
  );
  assert.match(tap, /# tests 3\n/);
  assert.match(tap, /# fail 3\n/);
});

test("per-file observation cap does not lose failures or suppress the next file", async (t) => {
  const cwd = await fixture(t),
    count = MAX_OBSERVER_PACKETS + 6;
  await writeFile(
    path.join(cwd, "tests/a.test.mjs"),
    imports +
      worker +
      `for(let i=0;i<${count};i++)test('failure '+i,async()=>{await assert.rejects(Promise.reject(worker()),/XML/);});\n`,
  );
  await writeFile(
    path.join(cwd, "tests/b.test.mjs"),
    imports +
      worker +
      "test('next file failure',async()=>{await assert.rejects(Promise.reject(worker()),/XML/);});\n",
  );
  await writeFile(
    path.join(cwd, "tests/c.test.mjs"),
    imports +
      worker +
      "test('last file pass',async()=>{await assert.rejects(Promise.reject(worker()),/interrupted/);});\n",
  );
  const { rows, tap } = await run(cwd, 1);
  const observations = rows.filter((row) => row.workerObservation);
  assert.equal(
    observations.filter((row) => row.file === "tests/a.test.mjs").length,
    MAX_OBSERVER_PACKETS,
  );
  assert.equal(
    observations.filter((row) => row.file === "tests/b.test.mjs").length,
    1,
  );
  assert.equal(
    observations.filter((row) => row.file === "tests/c.test.mjs").length,
    0,
  );
  assert.equal(
    observations.filter(
      (row) => row.workerObservation.availability === "capped",
    ).length,
    1,
  );
  assert(
    observations.every(
      (row) =>
        Buffer.byteLength(JSON.stringify(row.workerObservation)) <=
        MAX_PACKET_BYTES,
    ),
  );
  assert.match(tap, new RegExp(`# tests ${count + 2}\\n`));
  assert.match(tap, new RegExp(`# fail ${count + 1}\\n`));
  assert.match(tap, /# pass 1\n/);
  assert.match(tap, /# cancelled 0\n/);
  assert.equal(rows.at(-1).status, "failed");
});

test("inherited preload skips non-test main entries before loading node:test", async (t) => {
  const cwd = await fixture(t);
  const preload = pathToFileURL(
    path.join(cwd, "scripts/core-worker-observer-preload.mjs"),
  ).href;
  const code =
    "console.log(JSON.stringify({testFrameworkLoaded:process.moduleLoadList.some(value=>value.includes('internal/test_runner'))}));\n";
  for (const entry of [
    "scripts/cli.mjs",
    "outside.test.mjs",
    "tests/direct.test.mjs",
  ])
    await writeFile(path.join(cwd, entry), code);
  for (const [entry, context] of [
    ["scripts/cli.mjs", "child-v8"],
    ["outside.test.mjs", "child-v8"],
    ["tests/direct.test.mjs", undefined],
    ["tests/direct.test.mjs", "unsupported"],
  ]) {
    const environment = { ...env };
    if (context !== undefined) environment.NODE_TEST_CONTEXT = context;
    const result = invoke(cwd, [`--import=${preload}`, entry], environment);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { testFrameworkLoaded: false });
  }
});

test("missing eligible observer setup leaves original pass and fail outcomes unchanged", async (t) => {
  const cwd = await fixture(t);
  const preload = pathToFileURL(
    path.join(cwd, "scripts/core-worker-observer-preload.mjs"),
  ).href;
  await rm(path.join(cwd, "scripts/core-worker-observations.mjs"));
  await writeFile(
    path.join(cwd, "tests/setup.test.mjs"),
    imports +
      "test('pass',()=>{});test('fail',()=>{assert.fail('deliberate');});\n",
  );
  const result = invoke(cwd, [
    `--import=${preload}`,
    "--test",
    "--test-reporter=tap",
    "tests/setup.test.mjs",
  ]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /# pass 1\n/);
  assert.match(result.stdout, /# fail 1\n/);
  assert.doesNotMatch(result.stdout, /CORE_WORKER_OBSERVATION_V1/);
});

test("independent successful rejection run stays exit zero without observations", async (t) => {
  const cwd = await fixture(t);
  await writeFile(
    path.join(cwd, "tests/pass.test.mjs"),
    imports +
      worker +
      "test('matching success',async()=>{await assert.rejects(Promise.reject(worker()),/interrupted/);});\n",
  );
  const { rows, tap } = await run(cwd, 0);
  assert(!rows.some((row) => row.workerObservation));
  assert.equal(rows.at(-1).status, "passed");
  assert.match(tap, /# pass 1\n/);
  assert.match(tap, /# fail 0\n/);
});

test("diagnostic emitter failure never replaces the original assertion failure", async (t) => {
  const cwd = await fixture(t);
  await writeFile(
    path.join(cwd, "tests/emitter.test.mjs"),
    imports +
      worker +
      "test('original failure',async(context)=>{context.diagnostic=()=>{throw Error('EMITTER_MUST_NOT_REPLACE');};await assert.rejects(Promise.reject(worker()),/XML/);});\n",
  );
  const { rows, tap } = await run(cwd, 1);
  assert(!rows.some((row) => row.workerObservation));
  assert.equal(rows.at(-1).status, "failed");
  assert.match(tap, /The input did not match the regular expression \/XML\//);
  assert.doesNotMatch(tap, /EMITTER_MUST_NOT_REPLACE/);
  assert.match(tap, /# fail 1\n/);
});
