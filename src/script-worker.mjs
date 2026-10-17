import { parentPort, workerData } from 'node:worker_threads';
import { getQuickJS } from 'quickjs-emscripten';
let runtime, context;
try {
  const engine = await getQuickJS();
  runtime = engine.newRuntime();
  runtime.setMemoryLimit(16 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + 250;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  context = runtime.newContext();
  const setup = `
    const input = ${JSON.stringify(workerData.input)};
    const variables = Object.assign(Object.create(null), input.variables || {});
    const request = input.request || {};
    const response = input.response || null;
    const logs = [], tests = [];
    const console = { log: (...values) => {
      if (logs.length < 100) logs.push(values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ').slice(0,2000));
    }};
    const set = (name, value) => {
      if (['__proto__','prototype','constructor'].includes(name)) throw Error('Invalid variable name');
      variables[name] = value;
    };
    const apt = { setVar: set, getVar: name => variables[name] };
    const pm = {
      environment: { set, get: name => variables[name], unset: name => delete variables[name] },
      response: { code: response?.status, json: () => JSON.parse(response?.body || 'null'), text: () => response?.body || '' },
      test: (name, fn) => { try { fn(); tests.push({ name, passed: true }); } catch (e) { tests.push({ name, passed: false, error: String(e.message) }); } },
      expect: actual => ({ to: { equal: expected => { if (actual !== expected) throw Error('Expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); } } })
    };
  `;
  for (const code of [setup, workerData.code]) {
    const result = context.evalCode(code);
    if (result.error) { const error = context.dump(result.error); result.error.dispose(); throw Error(error.message || JSON.stringify(error)); }
    result.value.dispose();
  }
  const output = context.evalCode('JSON.stringify({variables, request, logs, tests})');
  if (output.error) { output.error.dispose(); throw Error('脚本输出不可序列化'); }
  const json = context.getString(output.value);
  output.value.dispose();
  if (json.length > 1024 * 1024) throw Error('脚本输出超过 1 MiB');
  parentPort.postMessage({ result: JSON.parse(json) });
} catch (error) { parentPort.postMessage({ error: error.message }); }
finally { context?.dispose(); runtime?.dispose(); }
