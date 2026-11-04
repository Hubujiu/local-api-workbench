import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const sourceURL = new URL(
  "../src/scripts.mjs?host-terminal-race",
  import.meta.url,
).href;
const shim =
  "data:text/javascript," +
  encodeURIComponent(`
 import { EventEmitter } from 'node:events';
 export class Worker extends EventEmitter {
   constructor() {
     super();
     this.terminal = setTimeout(() => this.emit('message', { result: {} }), 5);
     this.exitTimer = setTimeout(() => this.emit('exit', 0), 500);
     queueMicrotask(() => this.emit('online'));
   }
   postMessage() {}
   async terminate() { clearTimeout(this.terminal); clearTimeout(this.exitTimer); this.emit('exit', 1); return 1; }
 }
`);
const hooks = registerHooks({
  load(url, context, next) {
    const output = next(url, context);
    if (url !== sourceURL) return output;
    const source = output.source.toString(),
      anchor = 'import { Worker } from "node:worker_threads";';
    assert(source.includes(anchor));
    return {
      ...output,
      source: source.replace(
        anchor,
        `import { Worker } from ${JSON.stringify(shim)};`,
      ),
    };
  },
});
const { runScript } = await import(sourceURL);
hooks.deregister();

test("terminal message does not settle before worker exit and timeout still wins", async () => {
  let error;
  try {
    await runScript(
      "return 1",
      { request: {}, variables: {} },
      { wallBudgetMs: 100 },
    );
  } catch (e) {
    error = e;
  }
  assert(error);
  assert.equal(error.scriptStage, "total-deadline");
  assert.equal(error.hostLifecycle.terminalKind, "result");
  assert(error.hostLifecycle.terminalMs < error.hostLifecycle.timerFireMs);
  assert.equal(error.hostLifecycle.finishReason, "total-deadline");
  assert(Number.isSafeInteger(error.hostLifecycle.exitMs));
});
