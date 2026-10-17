import { Worker } from 'node:worker_threads';

/** JS executes in a separate QuickJS/WASM VM with no Node, network or filesystem bindings. */
export function runScript(code, input) {
  if (typeof code !== 'string' || code.length > 100000) throw Error('脚本不能超过 100 KB');
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./script-worker.mjs', import.meta.url), {
      workerData: { code, input },
      resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 2 },
    });
    const timer = setTimeout(() => { worker.terminate(); reject(Error('脚本执行超时')); }, 2000);
    worker.once('message', message => {
      clearTimeout(timer);
      worker.terminate();
      if (message.error) reject(Error(message.error)); else resolve(message.result);
    });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', code => {
      clearTimeout(timer);
      if (code !== 0) reject(Error('脚本执行进程被终止'));
    });
  });
}
