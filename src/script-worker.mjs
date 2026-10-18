import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { scopeRuntimeSource } from "./variable-scopes.mjs";
import { parentPort, workerData } from "node:worker_threads";
import { getQuickJS } from "quickjs-emscripten";
let runtime, context;
try {
  const trustedLibraries = await readFile(
    new URL("./vendor/script-libraries.js", import.meta.url),
    "utf8",
  );
  const engine = await getQuickJS();
  runtime = engine.newRuntime();
  runtime.setMemoryLimit(16 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  let deadline = Date.now() + 1000;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  context = runtime.newContext();
  const randomFunction = context.newFunction("__randomBytes", (countHandle) => {
    const count = context.getNumber(countHandle);
    if (!Number.isInteger(count) || count < 0 || count > 65536)
      return { error: context.newError("随机字节请求须为0至65536") };
    return context.newString(JSON.stringify([...randomBytes(count)]));
  });
  context.setProp(context.global, "__randomBytes", randomFunction);
  randomFunction.dispose();
  const setup = `
    const input = ${JSON.stringify(workerData.input)};
    globalThis.Event = class {
      constructor(type, options={}) { this.type=String(type);this.cancelable=Boolean(options.cancelable);this.defaultPrevented=false; }
      preventDefault(){if(this.cancelable)this.defaultPrevented=true;}
    };
    globalThis.EventTarget = class {
      constructor(){this.listeners=new Map();}
      addEventListener(type, listener, options={}) {
        if(!listener)return;
        const list=this.listeners.get(String(type)) || [];
        if(!list.some(item=>item.listener===listener))list.push({listener,once:Boolean(options?.once)});
        this.listeners.set(String(type),list);
      }
      removeEventListener(type,listener){this.listeners.set(String(type),(this.listeners.get(String(type)) || []).filter(item=>item.listener!==listener));}
      dispatchEvent(event){
        if(!(event instanceof Event))throw Error('Event expected');
        for(const item of [...(this.listeners.get(event.type) || [])]) {
          if(item.once)this.removeEventListener(event.type,item.listener);
          if(typeof item.listener === 'function')item.listener.call(this,event);
          else item.listener.handleEvent?.(event);
        }
        return !event.defaultPrevented;
      }
    };
    globalThis.crypto=Object.freeze({
      getRandomValues: array => {
        if(!ArrayBuffer.isView(array) || array instanceof DataView || array instanceof Float32Array || array instanceof Float64Array) throw Error('随机数据需要整数TypedArray');
        const bytes=JSON.parse(__randomBytes(array.byteLength));
        new Uint8Array(array.buffer,array.byteOffset,array.byteLength).set(bytes);
        return array;
      }
    });
    globalThis.require = name => {
      if(name === 'crypto-js') return globalThis.CryptoJS;
      if(name === 'chai') return globalThis.chai;
      throw Error('不允许加载模块: ' + name);
    };
    ${scopeRuntimeSource}
    const scopeState = createScopes(input.variables || {}, input.scopes);
    const variables = effectiveScopes(scopeState);
    const refreshVariables = () => {
      for (const name of Object.keys(variables)) delete variables[name];
      Object.assign(variables, effectiveScopes(scopeState));
    };
    const scopedAPI = map => ({
      set: (name, value) => { variableName(name); map[name] = value; refreshVariables(); },
      get: name => map[name],
      has: name => Object.prototype.hasOwnProperty.call(map, name),
      unset: name => { variableName(name); delete map[name]; refreshVariables(); },
      clear: () => { for (const name of Object.keys(map)) delete map[name]; refreshVariables(); },
      toObject: () => copyVariableValue(map)
    });
    const environmentAPI = scopedAPI(scopeState.environment);
    const globalsAPI = scopedAPI(scopeState.globals);
    const localVariables = Object.assign(Object.create(null), input.localVariables || {});
    const request = input.request || {};
    const response = input.response || null;
    const logs = [], tests = [];
    const console = { log: (...values) => {
      if (logs.length < 100) logs.push(values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ').slice(0,2000));
    }};
    const set = (name, value) => {
      if (['__proto__','prototype','constructor'].includes(name)) throw Error('Invalid variable name');
      scopeState.runtime[name] = value;
      scopeState.hidden = scopeState.hidden.filter(item => item !== name);
      refreshVariables();
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
      environment: environmentAPI, variables: environmentAPI, globals: globalsAPI,
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
      variables: {
        set: (name, value) => { parameterName(name); localVariables[name] = value; },
        get: name => localVariables[name],
        has: name => Object.prototype.hasOwnProperty.call(localVariables, name),
        unset: name => delete localVariables[name],
        clear: () => { for (const name of Object.keys(localVariables)) delete localVariables[name]; }
      },
      environment: environmentAPI,
      globals: globalsAPI,
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
          (fn.kind === "transform"
            ? "]=(text,...rest)=>{const args=[text,...rest];\n"
            : "]=(...args)=>{\n") +
          fn.body +
          "\n};",
      )
      .join("\n");
  const run = (code) => {
    const result = context.evalCode(code);
    if (result.error) {
      const error = context.dump(result.error);
      result.error.dispose();
      throw Error(error.message || JSON.stringify(error));
    }
    result.value.dispose();
  };
  run(setup);
  run(trustedLibraries);
  deadline = Date.now() + 250;
  run("pm.expect = chai.expect; apt.expect = chai.expect; apt.test = pm.test;");
  for (const code of [library, workerData.code]) {
    const result = context.evalCode(code);
    if (result.error) {
      const error = context.dump(result.error);
      result.error.dispose();
      throw Error(error.message || JSON.stringify(error));
    }
    result.value.dispose();
  }
  const output = context.evalCode(
    "applyLegacyVariables(scopeState, effectiveScopes(scopeState), variables); JSON.stringify({variables: effectiveScopes(scopeState), scopes: scopeState, localVariables, request, logs, tests})",
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
