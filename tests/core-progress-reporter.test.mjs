import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { spawnSync, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import progress, {
  projectEvent,
  MAX_BYTES,
  MAX_LINES,
} from "../scripts/core-progress-reporter.mjs";

const launcher = fileURLToPath(
  new URL("../scripts/run-core-tests.mjs", import.meta.url),
);
const reporter = new URL(
  "../scripts/core-progress-reporter.mjs",
  import.meta.url,
).href;
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
async function fixture(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "core-progress-"));
  await mkdir(path.join(cwd, "tests"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}
function parse(output) {
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("progress projects only bounded scalar fields and safe relative paths", () => {
  const cwd = process.cwd();
  let reads = 0;
  const data = {
    file: path.join(cwd, "tests", "safe.test.mjs"),
    name: "test\nname",
    nesting: 0,
    line: 9,
    details: {
      passed: false,
      duration_ms: 12.5,
      get error() {
        reads++;
        throw Error("secret");
      },
    },
    get message() {
      reads++;
      throw Error("secret");
    },
    toJSON() {
      reads++;
      throw Error("secret");
    },
  };
  const row = projectEvent({ type: "test:complete", data }, 20, cwd);
  assert.deepEqual(JSON.parse(JSON.stringify(row)), {
    type: "test:complete",
    elapsedMs: 20,
    file: "tests/safe.test.mjs",
    name: "test name",
    line: 9,
    nesting: 0,
    status: "failed",
    durationMs: 12.5,
  });
  assert.equal(reads, 0);
  assert.equal(projectEvent({ type: "test:stdout", data }, 0, cwd), undefined);
  const malformed = projectEvent(
    {
      type: "test:complete",
      data: {
        file: path.resolve(cwd, "../outside"),
        name: {
          toString() {
            throw Error("secret");
          },
        },
        line: Infinity,
        nesting: -1,
        details: { passed: "true", duration_ms: NaN },
      },
    },
    0,
    cwd,
  );
  assert.equal(malformed.file, undefined);
  assert.equal(malformed.name, undefined);
  assert.equal(malformed.status, "unknown");
  assert.equal(malformed.durationMs, undefined);
  assert.equal(
    projectEvent(
      { type: "test:dequeue", data: { name: "x".repeat(1000) } },
      0,
      cwd,
    ).name.length,
    256,
  );
  assert.equal(
    projectEvent(
      { type: "test:dequeue", data: Object.create({ name: "secret" }) },
      0,
      cwd,
    ).name,
    undefined,
  );
  assert.equal(
    projectEvent(
      {
        type: "test:dequeue",
        data: {
          get name() {
            reads++;
          },
        },
      },
      0,
      cwd,
    ).name,
    undefined,
  );
  assert.equal(reads, 0);
});

test("progress caps lines and bytes but drains every remaining event", async () => {
  for (const name of ["short", "雪".repeat(256)]) {
    let consumed = 0;
    async function* events() {
      for (let i = 0; i < MAX_LINES + 30; i++) {
        consumed++;
        yield { type: "test:dequeue", data: { name } };
      }
    }
    const chunks = [];
    for await (const line of progress(events())) chunks.push(line);
    const output = chunks.join("");
    assert.equal(consumed, MAX_LINES + 30);
    assert(chunks.length <= MAX_LINES);
    if (name === "short") assert.equal(chunks.length, MAX_LINES);
    else assert(chunks.length < MAX_LINES);
    assert(Buffer.byteLength(output) <= MAX_BYTES);
    assert.equal(parse(output).at(-1).type, "progress:truncated");
    assert.equal(
      parse(output).filter((x) => x.type === "progress:truncated").length,
      1,
    );
  }
});

test("launcher preserves success and failure with spec TAP and JSONL together", async (t) => {
  const cwd = await fixture(t);
  for (const fails of [false, true]) {
    await writeFile(
      path.join(cwd, "tests", "example.test.mjs"),
      `import test from 'node:test';\ntest('fixture result', () => { console.log('DO_NOT_COPY_BODY'); ${fails ? "throw Error('DO_NOT_COPY_ERROR');" : ""} });\n`,
    );
    const result = spawnSync(
      process.execPath,
      [launcher, "--shard=1/1", "--label=fixture"],
      { cwd, env, encoding: "utf8", timeout: 10000 },
    );
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, fails ? 1 : 0, result.stdout + result.stderr);
    const prefix = path.join(cwd, "test-results/core-fixture-shard-1-of-1");
    assert.match(
      await readFile(prefix + ".tap", "utf8"),
      fails ? /# fail 1/ : /# fail 0/,
    );
    assert.match(result.stdout, /fixture result/);
    const output = await readFile(prefix + ".progress.jsonl", "utf8"),
      rows = parse(output);
    assert(!output.includes("DO_NOT_COPY"));
    assert(!output.includes(cwd));
    assert(rows.some((row) => row.type === "test:dequeue"));
    assert(
      rows.some(
        (row) =>
          row.type === "test:complete" &&
          row.name === "fixture result" &&
          row.status === (fails ? "failed" : "passed"),
      ),
    );
    assert.equal(rows.at(-1).type, "test:summary");
    assert.equal(rows.at(-1).status, fails ? "failed" : "passed");
    assert(
      rows.every((row, i) => i === 0 || row.elapsedMs >= rows[i - 1].elapsedMs),
    );
  }
});

test("completion is persisted before process exit and cancellation stays nonzero", async (t) => {
  const cwd = await fixture(t),
    destination = path.join(cwd, "live.jsonl");
  await writeFile(
    path.join(cwd, "tests", "live.test.mjs"),
    "import test from 'node:test';\nsetInterval(() => {}, 1000);\ntest('completed before process exit', () => {});\n",
  );
  const child = spawn(
    process.execPath,
    [
      "--test",
      "--test-concurrency=1",
      `--test-reporter=${reporter}`,
      `--test-reporter-destination=${destination}`,
      "tests/live.test.mjs",
    ],
    { cwd, env, stdio: "ignore" },
  );
  const closed = once(child, "close");
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await closed;
  });
  const deadline = performance.now() + 8000;
  let output = "";
  while (performance.now() < deadline) {
    output = await readFile(destination, "utf8").catch(() => "");
    if (
      output.includes('"name":"completed before process exit"') &&
      parse(output).some(
        (row) =>
          row.type === "test:complete" &&
          row.name === "completed before process exit",
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert(
    parse(output).some(
      (row) =>
        row.type === "test:complete" &&
        row.name === "completed before process exit",
    ),
    output,
  );
  assert.equal(child.exitCode, null);
  assert(
    !parse(output).some((row) => row.type === "test:summary" && !row.file),
  );
  child.kill("SIGTERM");
  const [code, signal] = await closed;
  assert(code !== 0 || signal !== null);
  assert((await readFile(destination, "utf8")).startsWith(output));
});
