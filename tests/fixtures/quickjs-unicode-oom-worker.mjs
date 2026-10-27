import { parentPort, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { trackedQuickJS } from "../../src/tracked-quickjs.mjs";

const LIMIT = 16 * 1024 * 1024;
const patterns = ["\\p{Script=Common}", "\\p{Script_Extensions=Common}"];
if (!patterns.includes(workerData.pattern))
  throw Error("unexpected test pattern");
const reserve = 512;

const tracked = await trackedQuickJS(workerData.compiled);
const runtime = tracked.engine.newRuntime();
runtime.setMemoryLimit(LIMIT);
runtime.setMaxStackSize(512 * 1024);
const context = runtime.newContext();
const started = performance.now();
let checks = 0,
  expiredChecks = 0;
runtime.setInterruptHandler(() => {
  checks++;
  const expired = performance.now() - started >= 250;
  if (expired) expiredChecks++;
  return expired;
});

function allocation() {
  const match = runtime
    .dumpMemoryUsage()
    .match(/^memory allocated\s+(\d+)\s+(\d+)/m);
  if (!match) throw Error("missing actual allocator accounting");
  return { count: Number(match[1]), bytes: Number(match[2]) };
}
function consume(result) {
  const handle = result.error || result.value;
  try {
    return { error: !!result.error, value: context.dump(handle) };
  } finally {
    handle.dispose();
  }
}

let probe, recover, output;
try {
  const setup = consume(
    context.evalCode(`
      // Avoid retaining a setup-only string in the first allocator baseline.
      globalThis.phase = undefined;
      globalThis.probe = function(bytes) {
        phase = 'fill';
        let held = new ArrayBuffer(bytes);
        const filled = held.byteLength;
        let caught;
        phase = 'compile';
        try { new RegExp(${JSON.stringify(workerData.pattern)}, 'u'); }
        catch (error) { caught = error; }
        held = null;
        phase = 'released';
        return caught
          ? [caught.name, caught.message, filled]
          : ['unexpected success', '', filled];
      };
      globalThis.recover = function() {
        return [new ArrayBuffer(1024*1024).byteLength,
          new RegExp(${JSON.stringify(workerData.pattern)}, 'u').test('.')];
      };
      // Warm the ordinary error constructor before taking allocator baselines.
      new SyntaxError('out of memory');
      undefined;
    `),
  );
  if (setup.error) throw Error(JSON.stringify(setup));
  probe = context.getProp(context.global, "probe");
  recover = context.getProp(context.global, "recover");
  const warm = consume(context.callFunction(recover, context.undefined));
  const rounds = [];
  // A fixed two attempts checks cleanup, never an unbounded fill/search loop.
  for (let index = 0; index < 2; index++) {
    const before = allocation();
    const fillBytes = LIMIT - before.bytes - reserve;
    if (!(fillBytes > 15 * 1024 * 1024 && fillBytes < LIMIT))
      throw Error("unexpected bounded fixture allocation size");
    const bytes = context.newNumber(fillBytes);
    let result;
    try {
      result = consume(context.callFunction(probe, context.undefined, bytes));
    } finally {
      bytes.dispose();
    }
    const afterFailure = allocation();
    const recovery = consume(context.callFunction(recover, context.undefined));
    const afterRecovery = allocation();
    rounds.push({
      before,
      fillBytes,
      result,
      afterFailure,
      recovery,
      afterRecovery,
    });
    if (result.error) break;
  }
  const phase = context.getProp(context.global, "phase");
  try {
    output = {
      reserve,
      warm,
      rounds,
      phase: context.dump(phase),
      elapsedMs: performance.now() - started,
      checks,
      expiredChecks,
    };
  } finally {
    phase.dispose();
  }
} finally {
  probe?.dispose();
  recover?.dispose();
  context.dispose();
  runtime.dispose();
}
output.unhandledAfterDispose = tracked.unhandledCount();
parentPort.postMessage(output);
