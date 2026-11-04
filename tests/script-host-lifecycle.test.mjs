import test from "node:test";
import assert from "node:assert/strict";
import {
  observeHostLifecycle,
  sanitizeHostLifecycle,
  sanitizeHostSequence,
} from "../src/script-host-lifecycle.mjs";
import { runScript, runScriptSequence } from "../src/scripts.mjs";
import { scriptFailureDetails } from "../src/script-diagnostics.mjs";
import { workerFailureMetadata } from "./helpers/worker-rejection-diagnostics.mjs";
import { executionResultMetadata } from "./helpers/execution-result-diagnostics.mjs";
import { cliResultMetadata } from "./helpers/cli-result-diagnostics.mjs";
import { projectWorkerFailure } from "../scripts/core-worker-observations.mjs";

test("observer records first bounded relative timestamps without changing outcomes", () => {
  let now = 100;
  const o = observeHostLifecycle(() => now);
  now = 102;
  o.mark("spawnMs");
  now = 105;
  o.mark("timerArmMs");
  o.dueAt(125);
  now = 107;
  o.mark("onlineMs");
  now = 110;
  o.stage("compatibility");
  now = 111;
  o.stage("compatibility");
  now = 120;
  o.terminal("result");
  now = 122;
  o.exit(0);
  o.finish("worker-exit");
  o.mark("settleMs");
  assert.deepEqual(o.snapshot(), {
    version: 1,
    spawnMs: 2,
    timerArmMs: 5,
    timerTargetMs: 25,
    onlineMs: 7,
    compatibilityMs: 10,
    terminalKind: "result",
    terminalMs: 20,
    exitMs: 22,
    exitCode: 0,
    finishReason: "worker-exit",
    finishMs: 22,
    settleMs: 22,
  });
});

test("malformed descriptors and arbitrary values are excluded without executing hooks", () => {
  let calls = 0;
  const obj = {
    version: 1,
    finishReason: "private",
    spawnMs: NaN,
    exitCode: 256,
  };
  Object.defineProperty(obj, "onlineMs", {
    get() {
      calls++;
      throw Error("getter");
    },
  });
  assert.deepEqual(sanitizeHostLifecycle(obj), { version: 1 });
  assert.equal(
    sanitizeHostLifecycle(
      new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            calls++;
            throw Error("proxy");
          },
        },
      ),
    ),
    undefined,
  );
  assert.deepEqual(
    sanitizeHostSequence({
      version: 1,
      stageIndex: 1,
      completed: 1,
      elapsedMs: 11,
      secret: "private",
    }),
    { version: 1, stageIndex: 1, completed: 1, elapsedMs: 11 },
  );
  assert.equal(calls, 0);
});

test("real worker failures retain bounded lifecycle without replacing the error", async () => {
  let caught;
  try {
    await runScript('throw Error("expected-lifecycle-error")', {
      request: {},
      variables: {},
    });
  } catch (error) {
    caught = error;
  }
  assert(caught);
  assert.match(caught.message, /expected-lifecycle-error/);
  assert.equal(caught.hostLifecycle.version, 1);
  assert.equal(caught.hostLifecycle.finishReason, "worker-exit");
  assert.equal(caught.hostLifecycle.terminalKind, "error");
  assert(Number.isSafeInteger(caught.hostLifecycle.exitMs));
  assert(Number.isSafeInteger(caught.hostLifecycle.settleMs));
});

test("sequence failure summarizes previous successful worker timings without replay", async () => {
  let caught;
  try {
    await runScriptSequence(
      [
        { name: "first", code: "pm.variables.set('v',1);" },
        { name: "second", code: "throw Error('expected-second');" },
      ],
      { request: {}, variables: {} },
    );
  } catch (error) {
    caught = error;
  }
  assert(caught);
  assert.match(caught.message, /expected-second/);
  assert.equal(caught.hostSequence.stageIndex, 1);
  assert.equal(caught.hostSequence.completed, 1);
  assert(Number.isSafeInteger(caught.hostSequence.priorWorkerMs));
  assert.equal(caught.sequenceActivity.length, 1);
  const publicResult = scriptFailureDetails(caught);
  assert.equal(publicResult.scriptDiagnostics.hostSequence.completed, 1);
  assert.equal(workerFailureMetadata(caught).hostSequence.completed, 1);
  const cli = cliResultMetadata(
    JSON.stringify({
      status: "failed",
      results: [{ status: "failed", ...publicResult }],
    }),
  );
  assert.equal(cli.steps[0].hostSequence.completed, 1);
});

test("host timeout preserves cause and records termination and exit", async () => {
  let caught;
  try {
    await runScript(
      "await new Promise(r=>setTimeout(r, 1000));",
      { request: {}, variables: {} },
      { wallBudgetMs: 150 },
    );
  } catch (error) {
    caught = error;
  }
  assert(caught);
  assert.equal(caught.scriptStage, "total-deadline");
  assert.equal(caught.hostLifecycle.finishReason, "total-deadline");
  assert(Number.isSafeInteger(caught.hostLifecycle.timerFireMs));
  assert(Number.isSafeInteger(caught.hostLifecycle.terminateMs));
  assert(Number.isSafeInteger(caught.hostLifecycle.exitMs));
  const publicResult = scriptFailureDetails(caught);
  assert.equal(
    publicResult.scriptDiagnostics.hostLifecycle.finishReason,
    "total-deadline",
  );
  const worker = workerFailureMetadata(caught);
  assert.equal(worker.hostLifecycle.finishReason, "total-deadline");
  const execution = executionResultMetadata({
    status: "failed",
    error: caught.message,
    ...publicResult,
  });
  assert.equal(
    execution.scriptDiagnostics.hostLifecycle.finishReason,
    "total-deadline",
  );
  const cli = cliResultMetadata(
    JSON.stringify({
      status: "failed",
      results: [{ status: "failed", ...publicResult }],
    }),
  );
  assert.equal(cli.steps[0].hostLifecycle.finishReason, "total-deadline");
  const packet = projectWorkerFailure(caught);
  assert.equal(packet.workers[0].hostLifecycle.finishReason, "total-deadline");
  assert(Buffer.byteLength(JSON.stringify(packet)) < 2048);
});

test("execution projection never uses a polluted array iterator for host observations", () => {
  const descriptor = Object.getOwnPropertyDescriptor(
    Array.prototype,
    Symbol.iterator,
  );
  let calls = 0,
    result;
  Object.defineProperty(Array.prototype, Symbol.iterator, {
    configurable: true,
    value() {
      calls++;
      throw Error("iterator must not run");
    },
  });
  try {
    result = executionResultMetadata({
      status: "failed",
      scriptDiagnostics: {
        hostLifecycle: { version: 1, spawnMs: 1 },
        hostSequence: { version: 1, completed: 1 },
      },
    });
  } finally {
    Object.defineProperty(Array.prototype, Symbol.iterator, descriptor);
  }
  assert.equal(calls, 0);
  assert.equal(result.scriptDiagnostics.hostLifecycle.spawnMs, 1);
});

test("sequence exhausted before worker admission includes bounded host summary without a worker", async () => {
  let error;
  try {
    await runScriptSequence(
      [{ name: "never", code: "throw Error('must-not-run')" }],
      { request: {}, variables: {} },
      { wallBudgetMs: Number.MIN_VALUE },
    );
  } catch (value) {
    error = value;
  }
  assert(error);
  assert.equal(error.scriptStage, "sequence-budget");
  assert.equal(error.hostSequence.stageIndex, 0);
  assert.equal(error.hostSequence.completed, 0);
  assert.equal(error.hostLifecycle, undefined);
  assert.deepEqual(error.sequenceActivity, []);
});
