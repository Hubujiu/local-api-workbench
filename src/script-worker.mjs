import { parentPort, workerData } from "node:worker_threads";
import { getQuickJS } from "quickjs-emscripten";
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
    const parameterName = name => {
      if (typeof name !== 'string' || !name || ['__proto__','prototype','constructor'].includes(name))
        throw Error('Invalid parameter name');
      return name;
    };
    const modifyPair = (group, name, value, remove = false) => {
      parameterName(name);
      const equal = key => group === 'headers' ? String(key).toLowerCase() === name.toLowerCase() : key === name;
      const rows = request[group] || [];
      const existing = rows.find(row => equal(row.key));
      request[group] = rows.filter(row => !equal(row.key));
      if (!remove) request[group].push({ ...existing, key: name, value: String(value ?? ''), enabled: true });
    };
    const removeURLQuery = name => {
      const raw = String(request.url || '');
      const hashAt = raw.indexOf('#');
      const fragment = hashAt < 0 ? '' : raw.slice(hashAt);
      const base = hashAt < 0 ? raw : raw.slice(0, hashAt);
      const at = base.indexOf('?');
      if (at < 0) return;
      const query = base.slice(at + 1).split('&').filter(pair => {
        const key = pair.split('=')[0].split('+').join(' ');
        try { return decodeURIComponent(key) !== name; } catch { return true; }
      }).join('&');
      request.url = base.slice(0, at) + (query ? '?' + query : '') + fragment;
    };
    const modifyBody = (name, value, remove = false) => {
      parameterName(name);
      if (['form-data','urlencoded'].includes(request.bodyType)) {
        if (!remove && (request.form || []).some(row => row.key === name && row.type === 'file'))
          throw Error('File fields cannot be replaced with a text parameter');
        modifyPair('form', name, value, remove);
        return;
      }
      if (!['json','raw','msgpack',undefined].includes(request.bodyType))
        throw Error('Body parameter edits require JSON or form body');
      const object = JSON.parse(request.body || '{}');
      if (!object || typeof object !== 'object' || Array.isArray(object)) throw Error('Body must be a JSON object');
      if (remove) delete object[name]; else object[name] = value;
      request.body = JSON.stringify(object);
      if (!request.bodyType) request.bodyType = 'json';
    };
    const apt = {
      setVar: set, getVar: name => variables[name],
      setRequestHeader: (name, value) => modifyPair('headers', name, value),
      removeRequestHeader: name => modifyPair('headers', name, null, true),
      setRequestQuery: (name, value) => { parameterName(name); removeURLQuery(name); modifyPair('query', name, value); },
      removeRequestQuery: name => { parameterName(name); removeURLQuery(name); modifyPair('query', name, null, true); },
      setRequestBody: (...args) => {
        if (args.length === 1) {
          const value = args[0];
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Replacement body must be an object');
          request.body = JSON.stringify(value); request.bodyType = 'json';
        } else modifyBody(args[0], args[1]);
      },
      removeRequestBody: name => modifyBody(name, null, true)
    };
    const pm = {
      environment: { set, get: name => variables[name], unset: name => delete variables[name] },
      response: { code: response?.status, json: () => JSON.parse(response?.body || 'null'), text: () => response?.body || '' },
      test: (name, fn) => { try { fn(); tests.push({ name, passed: true }); } catch (e) { tests.push({ name, passed: false, error: String(e.message) }); } },
      expect: actual => ({ to: { equal: expected => { if (actual !== expected) throw Error('Expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); } } })
    };
  `;
  const library =
    "const utils=Object.create(null);\n" +
    (workerData.input.functions || [])
      .map(
        (fn) =>
          "utils[" +
          JSON.stringify(fn.name) +
          "]=(...args)=>{\n" +
          fn.body +
          "\n};",
      )
      .join("\n");
  for (const code of [setup, library, workerData.code]) {
    const result = context.evalCode(code);
    if (result.error) {
      const error = context.dump(result.error);
      result.error.dispose();
      throw Error(error.message || JSON.stringify(error));
    }
    result.value.dispose();
  }
  const output = context.evalCode(
    "JSON.stringify({variables, request, logs, tests})",
  );
  if (output.error) {
    output.error.dispose();
    throw Error("脚本输出不可序列化");
  }
  const json = context.getString(output.value);
  output.value.dispose();
  if (json.length > 1024 * 1024) throw Error("脚本输出超过 1 MiB");
  parentPort.postMessage({ result: JSON.parse(json) });
} catch (error) {
  parentPort.postMessage({ error: error.message });
} finally {
  context?.dispose();
  runtime?.dispose();
}
