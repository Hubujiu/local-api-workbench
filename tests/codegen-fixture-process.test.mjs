import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runFixtureProcess } from "./helpers/codegen-fixture-process.mjs";
import { formatFixtureReceipt } from "./helpers/codegen-fixture-receipt.mjs";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test("fixture launcher reports safe build/execute failures and never treats timeout as success", async () => {
  for (const phase of ["build", "execute"]) {
    await assert.rejects(
      runFixtureProcess(
        process.execPath,
        ["-e", 'console.error("PRIVATE-SOURCE");process.exit(7)'],
        { phase, fixture: "fixture-0" },
      ),
      (error) => {
        assert.equal(error.receipt.phase, phase);
        assert.equal(error.receipt.exitCode, 7);
        assert.equal(error.receipt.timedOut, false);
        assert.equal(
          error.receipt.childClosed,
          true,
          formatFixtureReceipt(error.receipt),
        );
        assert.equal(
          error.receipt.cleanupConfirmed,
          true,
          formatFixtureReceipt(error.receipt),
        );
        assert(!error.message.includes("PRIVATE"));
        return true;
      },
    );
  }
  await assert.rejects(
    runFixtureProcess("missing-fixture-executable", [], {
      phase: "build",
      fixture: "fixture-0",
    }),
    (error) => error.receipt.spawnFailed || error.receipt.admissionFailed,
  );
});

for (const mode of ["timeout", "abort"])
  test(
    `fixture launcher ${mode} stops child and grandchild heartbeats`,
    { timeout: 20000 },
    async (t) => {
      const dir = await mkdtemp(join(tmpdir(), "codegen-tree-"));
      let cleanup = async () => {};
      t.after(async () => {
        await cleanup();
        await rm(dir, { recursive: true, force: true });
      });
      const marker = join(dir, "pulse");
      const pidFile = join(dir, "pid");
      const descendant = `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'x'),20);`;
      const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},1000);`;
      const controller = new AbortController();
      const pending = runFixtureProcess(process.execPath, ["-e", parent], {
        phase: "execute",
        fixture: "fixture-tree",
        timeoutMs: mode === "timeout" ? 5000 : 10000,
        signal: controller.signal,
      });
      const result = pending.catch((error) => error);
      cleanup = async () => {
        controller.abort();
        await result;
      };
      let pid;
      for (let i = 0; i < 400; i++) {
        try {
          pid = Number(await readFile(pidFile, "utf8"));
          await readFile(marker);
          break;
        } catch {
          await pause(10);
        }
      }
      assert(pid, "descendant must really start");
      if (mode === "abort") controller.abort();
      const error = await result;
      assert(error instanceof Error);
      assert.equal(error.receipt.timedOut, mode === "timeout");
      assert.equal(error.receipt.aborted, mode === "abort");
      assert.equal(
        error.receipt.childClosed,
        true,
        formatFixtureReceipt(error.receipt),
      );
      assert.equal(
        error.receipt.cleanupConfirmed,
        true,
        formatFixtureReceipt(error.receipt),
      );
      if (process.platform !== "win32")
        assert.equal(error.receipt.signal, "SIGKILL");
      const before = await readFile(marker, "utf8");
      await pause(150);
      assert.equal(
        await readFile(marker, "utf8"),
        before,
        "descendant heartbeat must stop",
      );
      try {
        process.kill(pid, 0);
        if (process.platform !== "linux")
          assert.fail("descendant is still alive");
        const state = await readFile(`/proc/${pid}/stat`, "utf8");
        assert.match(
          state,
          /\) Z /,
          "only a non-running zombie may await host reaping",
        );
      } catch (error) {
        if (error.code !== "ESRCH" && error.code !== "ENOENT") throw error;
      }
    },
  );

test("Go build planner writes every original source and invokes one bounded multi-package build without retries", async (t) => {
  const { buildGoFixtures } = await import(
    "./helpers/codegen-fixture-process.mjs"
  );
  const dir = await mkdtemp(join(tmpdir(), "codegen-build-plan-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sources = Array.from(
    { length: 8 },
    (_, index) => `package main\n// source-${index}\nfunc main() {}\n`,
  );
  const calls = [];
  const binaries = await buildGoFixtures(dir, sources, {
    run: async (...args) => {
      calls.push(args);
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "go");
  assert.deepEqual(calls[0][1], [
    "build",
    "-o",
    join(dir, "bin"),
    ...sources.map((_, index) => `./fixture-${index}`),
  ]);
  assert.equal(calls[0][2].timeoutMs, 60000);
  assert.equal(calls[0][2].phase, "build");
  assert.equal(calls[0][2].env.GOPROXY, "off");
  assert.equal(calls[0][2].env.GOTOOLCHAIN, "local");
  assert.equal(new Set(binaries).size, 8);
  for (let index = 0; index < sources.length; index++)
    assert.equal(
      await readFile(join(dir, `fixture-${index}`, "main.go"), "utf8"),
      sources[index],
    );
  const failedDir = await mkdtemp(join(tmpdir(), "codegen-build-failure-"));
  t.after(() => rm(failedDir, { recursive: true, force: true }));
  let failures = 0;
  const error = Error("bounded-build-failure");
  await assert.rejects(
    buildGoFixtures(failedDir, sources, {
      run: async () => {
        failures++;
        throw error;
      },
    }),
    error,
  );
  assert.equal(failures, 1, "no warm-cache retry on build failure");
});

test("wire observations never consume a late old request for the next fixture", async () => {
  const { createWireObservations } = await import(
    "./helpers/codegen-fixture-process.mjs"
  );
  const observed = createWireObservations();
  observed.record("/go/fixture-0", { body: "old" });
  assert.deepEqual(observed.takeOnly("/go/fixture-0"), { body: "old" });
  observed.assertUnseen("/go/fixture-1");
  await pause(10);
  observed.record("/go/fixture-0", { body: "late" });
  assert.throws(() => observed.takeOnly("/go/fixture-1"), /exactly one/);
  observed.record("/go/fixture-1", { body: "new" });
  assert.deepEqual(observed.takeOnly("/go/fixture-1"), { body: "new" });
  assert.throws(() => observed.assertUnseen("/go/fixture-1"), /premature/);
  assert.throws(() => observed.assertSingleArrivals(), /late duplicate/);
  assert.equal(observed.count, 3);
});

test("build timeout remains a build failure with the original bounded budget", async () => {
  await assert.rejects(
    runFixtureProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      phase: "build",
      fixture: "all-fixtures",
      timeoutMs: 100,
    }),
    (error) => {
      assert.equal(error.receipt.phase, "build");
      assert.equal(error.receipt.timedOut, true);
      assert.equal(
        error.receipt.childClosed,
        true,
        formatFixtureReceipt(error.receipt),
      );
      assert.equal(
        error.receipt.cleanupConfirmed,
        true,
        formatFixtureReceipt(error.receipt),
      );
      return true;
    },
  );
});

test(
  "fixture owner cleans live descendants after the direct parent exits successfully",
  { timeout: 15000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "codegen-parent-exit-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const marker = join(dir, "pulse"),
      pidFile = join(dir, "pid");
    const descendant = `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'x'),20);`;
    const parent = `const fs=require('node:fs');const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});child.unref();const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})){clearInterval(timer);process.exit(0);}},10);`;
    const result = await runFixtureProcess(process.execPath, ["-e", parent], {
      phase: "build",
      fixture: "parent-exit",
      timeoutMs: 10000,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.childClosed, true);
    assert.equal(result.cleanupConfirmed, true);
    const pid = Number(await readFile(pidFile, "utf8"));
    const before = await readFile(marker, "utf8");
    await pause(150);
    assert.equal(await readFile(marker, "utf8"), before);
    try {
      process.kill(pid, 0);
      if (process.platform !== "linux")
        assert.fail("descendant survived parent exit cleanup");
      assert.match(await readFile(`/proc/${pid}/stat`, "utf8"), /\) Z /);
    } catch (error) {
      if (error.code !== "ESRCH" && error.code !== "ENOENT") throw error;
    }
  },
);

test("bounded version probe timeout is failure rather than unavailable-tool skip", async () => {
  const { fixtureToolAvailable } = await import(
    "./helpers/codegen-fixture-process.mjs"
  );
  assert.equal(
    fixtureToolAvailable("missing-codegen-tool", [], {
      fixture: "tool-missing",
    }),
    false,
  );
  assert.equal(
    fixtureToolAvailable(process.execPath, ["--version"], {
      fixture: "tool-node",
      pattern: /^v/,
    }),
    true,
  );
  assert.throws(
    () =>
      fixtureToolAvailable(
        process.execPath,
        ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
        { fixture: "tool-stuck", timeoutMs: 200 },
      ),
    (error) => {
      assert.equal(error.receipt.phase, "probe");
      assert.equal(error.receipt.timedOut, true);
      return true;
    },
  );
});

test("fixture receipt diagnostics retain only bounded allowlisted status fields", () => {
  const text = formatFixtureReceipt({
    phase: "execute",
    fixture: "fixture-tree",
    childClosed: false,
    cleanupConfirmed: false,
    jobActiveProcesses: 0,
    finalWaitStatus: 258,
    finalWaitError: null,
    stopObserved: true,
    terminateJobAccepted: true,
    ownerReceiptValid: true,
    ownerReceiptBytes: 256,
    wrapperExitCode: 0,
    wrapperClosed: true,
    source: "PRIVATE-SOURCE",
    argv: ["PRIVATE-ARG"],
    env: { TOKEN: "PRIVATE-TOKEN" },
    stderr: "PRIVATE-STDERR",
    signal: "PRIVATE-SIGNAL",
    cleanupStage: "PRIVATE-STAGE",
  });
  assert(!text.includes("PRIVATE"));
  const receipt = JSON.parse(text);
  assert.equal(receipt.finalWaitStatus, 258);
  assert.equal(receipt.jobActiveProcesses, 0);
  assert.equal(receipt.childClosed, false);
  assert.equal(receipt.cleanupStage, null);
  assert.equal(receipt.signal, null);
  assert(text.length < 1200);
  const malformed = JSON.parse(
    formatFixtureReceipt({
      fixture: "secret " + "x".repeat(1000),
      jobActiveProcesses: Infinity,
      finalWaitStatus: "private",
      ownerReceiptBytes: 99999999,
      childClosed: "private",
    }),
  );
  assert.equal(malformed.fixture, null);
  assert.equal(malformed.jobActiveProcesses, null);
  assert.equal(malformed.finalWaitStatus, null);
  assert.equal(malformed.ownerReceiptBytes, null);
  assert.equal(malformed.childClosed, null);
});
