import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPlan,
  discoverCoreTests,
  parseOptions,
  runNode,
  runtimeDiagnostics,
} from "../scripts/run-core-tests.mjs";

const runner = fileURLToPath(
  new URL("../scripts/run-core-tests.mjs", import.meta.url),
);
const root = fileURLToPath(new URL("../", import.meta.url));
const cleanEnv = { ...process.env };
delete cleanEnv.NODE_TEST_CONTEXT;

async function fixture(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "core-sharding-"));
  await mkdir(path.join(cwd, "tests"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}
function invoke(cwd, args) {
  return spawnSync(process.execPath, [runner, ...args], {
    cwd,
    env: cleanEnv,
    encoding: "utf8",
    timeout: 20000,
  });
}
function successful(result) {
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

// Independent glob is the pre-change/npm-test baseline, not the sharder itself.
test("core shards exhaust the unchanged npm-test glob exactly once", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(root, "package.json")),
  );
  assert.equal(
    packageJson.scripts.test,
    "node --test --test-concurrency=2 tests/*.test.mjs",
  );
  const baseline = globSync("tests/*.test.mjs", { cwd: root })
    .map((file) => file.split(path.sep).join("/"))
    .sort();
  for (const total of [1, 2, 3, 4]) {
    const plans = await Promise.all(
      Array.from({ length: total }, (_, i) =>
        createPlan(root, { index: i + 1, total }),
      ),
    );
    assert.deepEqual(plans[0].files, baseline);
    const selected = plans.flatMap((plan) => plan.selected);
    assert.deepEqual(selected.sort(), baseline);
    assert.equal(new Set(selected).size, baseline.length);
    for (const plan of plans) {
      assert(plan.selected.length > 0);
      assert.equal(plan.fileConcurrency, 1);
      assert.equal(plan.filesSha256, plans[0].filesSha256);
      assert.deepEqual(plan.shards, plans[0].shards);
    }
  }
});

test("shard arguments reject missing, malformed, duplicate and unsafe values", () => {
  assert.deepEqual(parseOptions(["--shard=2/3", "--label=windows-latest"]), {
    index: 2,
    total: 3,
    label: "windows-latest",
    list: false,
  });
  for (const shard of [
    "",
    "0/2",
    "1/0",
    "3/2",
    "-1/2",
    "01/2",
    "1.5/2",
    "1/2x",
    "1/9007199254740992",
  ])
    assert.throws(() => parseOptions([`--shard=${shard}`, "--label=linux"]));
  for (const extra of [
    "--shard=1/2",
    "--label=macos",
    "--test-name-pattern=small",
    "--unknown",
    "--list",
    "tests/missing.test.mjs",
  ])
    assert.throws(() =>
      parseOptions(["--shard=1/2", "--label=linux", "--list", extra]),
    );
  for (const label of ["", "../escape", "bad name", "a\nb", "x".repeat(65)])
    assert.throws(() => parseOptions(["--shard=1/2", `--label=${label}`]));
});

test("file discovery is stable across creation order, Unicode, LF/CRLF and platform paths", async (t) => {
  const cwd = await fixture(t);
  const names = [
    "z.test.mjs",
    "é.test.mjs",
    "a space.test.mjs",
    "A.test.mjs",
    "中.test.mjs",
  ];
  for (const name of names)
    await writeFile(path.join(cwd, "tests", name), "// fixture\r\n");
  await writeFile(path.join(cwd, "tests", ".hidden.test.mjs"), "");
  await writeFile(path.join(cwd, "tests", "helper.mjs"), "");
  await mkdir(path.join(cwd, "tests", "nested"));
  await writeFile(path.join(cwd, "tests", "nested", "not-core.test.mjs"), "");
  const first = await createPlan(cwd, { index: 1, total: 2 });
  assert.deepEqual(
    first.files,
    names.sort().map((name) => `tests/${name}`),
  );
  for (const name of names)
    await writeFile(path.join(cwd, "tests", name), "// fixture\n");
  assert.deepEqual(await createPlan(cwd, { index: 1, total: 2 }), first);
  assert(
    first.files.every((name) => !name.includes("\\") && !name.includes("\r")),
  );
  const result = invoke(cwd, [
    "--shard=1/2",
    "--label=windows-latest",
    "--list",
  ]);
  successful(result);
  assert.equal(result.stdout.includes("\r"), false);
  const manifest = await readFile(
    path.join(cwd, "test-results/core-windows-latest-shard-1-of-2.json"),
    "utf8",
  );
  assert.equal(manifest.includes("\r"), false);
  assert.deepEqual(JSON.parse(manifest), first);
});

test("empty sets, empty shards and non-file matches fail before Node can ignore them", async (t) => {
  const cwd = await fixture(t);
  await assert.rejects(discoverCoreTests(cwd), /No core test files/);
  assert.notEqual(invoke(cwd, ["--shard=1/2", "--label=linux"]).status, 0);
  await writeFile(path.join(cwd, "tests", "one.test.mjs"), "");
  await assert.rejects(createPlan(cwd, { index: 1, total: 2 }), /nonempty/);
  await mkdir(path.join(cwd, "tests", "missing.test.mjs"));
  await assert.rejects(discoverCoreTests(cwd), /not a regular file/);
  assert.notEqual(invoke(cwd, ["--shard=1/1", "--label=linux"]).status, 0);
});

test("glob-like filenames cannot be silently ignored by Node", async (t) => {
  const cwd = await fixture(t);
  await writeFile(
    path.join(cwd, "tests", "[omitted].test.mjs"),
    "throw Error('must not be ignored');\n",
  );
  await assert.rejects(discoverCoreTests(cwd), /glob delimiter/);
  const result = invoke(cwd, ["--shard=1/1", "--label=linux"]);
  assert.ifError(result.error);
  assert.equal(result.status, 1);
});

test("real shards execute every file and nested concurrent test exactly once with separate TAP evidence", async (t) => {
  const cwd = await fixture(t);
  await mkdir(path.join(cwd, "seen"));
  const names = ["z", "a space", "中", "A", "é"];
  for (const name of names) {
    const source = `import test from 'node:test';
import { writeFile, unlink } from 'node:fs/promises';
test(${JSON.stringify(name)}, { concurrency: true, timeout: 5000 }, async (t) => {
  await writeFile('file-active', 'exclusive outer file', {flag: 'wx'});
  let started = 0, release;
  const ready = new Promise(r => release = r);
  await Promise.all([1, 2].map(n => t.test('concurrent ' + n, async () => {
    if (++started === 2) release();
    await ready;
    await writeFile(${JSON.stringify(`seen/${name}-`)} + n, 'once', {flag: 'wx'});
  })));
  await unlink('file-active');
});\n`;
    await writeFile(path.join(cwd, "tests", `${name}.test.mjs`), source);
  }
  const observed = [];
  for (const shard of [1, 2, 3, 4]) {
    const result = invoke(cwd, [`--shard=${shard}/4`, "--label=fixture"]);
    successful(result);
    const prefix = path.join(
      cwd,
      `test-results/core-fixture-shard-${shard}-of-4`,
    );
    const manifest = JSON.parse(await readFile(`${prefix}.json`, "utf8"));
    observed.push(...manifest.selected);
    const tap = await readFile(`${prefix}.tap`, "utf8");
    assert.match(tap, new RegExp(`# tests ${manifest.selected.length * 3}\\b`));
    assert.match(tap, /# fail 0\b/);
    assert.match(tap, /# skipped 0\b/);
  }
  assert.deepEqual(
    observed.sort(),
    names.map((name) => `tests/${name}.test.mjs`).sort(),
  );
  assert.equal(
    (await readdir(path.join(cwd, "seen"))).length,
    names.length * 2,
  );
});

test("real assertion failures remain failed and keep the shard manifest/TAP", async (t) => {
  const cwd = await fixture(t);
  await writeFile(
    path.join(cwd, "tests/fail.test.mjs"),
    "import test from 'node:test'; test('deliberate failure', () => { throw Error('fixture failed'); });\n",
  );
  const result = invoke(cwd, ["--shard=1/1", "--label=failed-fixture"]);
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(
    await readFile(
      path.join(cwd, "test-results/core-failed-fixture-shard-1-of-1.tap"),
      "utf8",
    ),
    /# fail 1\b/,
  );
});

test("Node child nonzero, signal termination and spawn errors cannot become success", async () => {
  assert.equal(await runNode(["-e", "process.exit(7)"]), 7);
  assert.equal(
    await runNode(["-e", "process.kill(process.pid, 'SIGTERM')"]),
    1,
  );
  assert.equal(
    await runNode([], {
      executable: path.join(os.tmpdir(), "missing-core-test-node", "node"),
    }),
    1,
  );
});

test("interrupting the wrapper forwards cancellation and never accepts a child zero exit", async (t) => {
  const cwd = await fixture(t);
  const wrapper = path.join(cwd, "wrapper.mjs");
  const child = `const fs = require('node:fs'); process.on('SIGTERM', () => process.exit(0)); fs.writeFileSync('ready', 'yes'); setInterval(() => {}, 100);`;
  await writeFile(
    wrapper,
    `import { runNode } from ${JSON.stringify(new URL("../scripts/run-core-tests.mjs", import.meta.url).href)};
import { existsSync } from 'node:fs';
const timer = setInterval(() => { if (existsSync('ready')) { clearInterval(timer); process.emit('SIGTERM'); } }, 10);
process.exitCode = await runNode(['-e', ${JSON.stringify(child)}]);\n`,
  );
  const result = spawnSync(process.execPath, [wrapper], {
    cwd,
    env: cleanEnv,
    encoding: "utf8",
    timeout: 20000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(await readFile(path.join(cwd, "ready"), "utf8"), "yes");
});

test("CI isolation has no selection filter and runtime diagnostics expose only explicit fields", async () => {
  const workflow = await readFile(
    path.join(root, ".github/workflows/ci.yml"),
    "utf8",
  );
  const core = workflow.split("  core:")[1].split("  browser:")[0];
  assert.match(core, /shard: \[1, 2, 3, 4\]/);
  assert.match(core, /timeout-minutes: 10/);
  assert.match(core, /if: always\(\)/);
  assert.match(core, /of-4\.progress\.jsonl/);
  assert.match(core, /fail-fast: false/);
  assert.match(core, /node-version: "24"/);
  assert.match(core, /os: \[ubuntu-latest, windows-latest, macos-latest\]/);
  assert.match(
    core,
    /run-core-tests\.mjs --shard=\$\{\{ matrix\.shard \}\}\/4 --label=\$\{\{ matrix\.os \}\}/,
  );
  assert.doesNotMatch(
    core,
    /--list|test-name|continue-on-error|retry|timeout-minutes: (?:[2-9]\d)/,
  );
  const diagnostics = runtimeDiagnostics();
  assert.deepEqual(
    Object.keys(diagnostics).sort(),
    [
      "node",
      "platform",
      "arch",
      "availableParallelism",
      "cpus",
      "totalmem",
      "ImageOS",
      "ImageVersion",
    ].sort(),
  );
  assert.equal(diagnostics.node, process.version);
  assert.equal(diagnostics.arch, process.arch);
  assert(diagnostics.availableParallelism > 0);
  assert(diagnostics.cpus > 0);
  assert(diagnostics.totalmem > 0);
});
