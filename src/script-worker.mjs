import { parseCSVRows } from "../public/csv-data.js";
import { fakerVariable } from "./faker-variables.mjs";
import { builtinVariableFactory } from "./builtin-variables.mjs";
import { ajaxCompatibilitySource } from "./script-ajax.mjs";
import { responseCompatibilitySource } from "./script-response.mjs";
import { scriptCompatibilitySource } from "./script-compatibility.mjs";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { scopeRuntimeSource } from "./variable-scopes.mjs";
import { parentPort, workerData } from "node:worker_threads";
import { trackedQuickJS } from "./tracked-quickjs.mjs";
let scriptStage = "bootstrap",
  outcome,
  runtime,
  context,
  rootPromise,
  finalizing = false;
const callbacks = new Map(),
  timers = new Map(),
  replies = [];
let wake,
  timerCount = 0,
  requestCount = 0;
const receive = (message) => {
  if (message.kind === "http") {
    replies.push(message);
    wake?.();
    wake = null;
  }
};
parentPort.on("message", receive);
try {
  const trustedLibraries = await readFile(
    new URL("./vendor/script-libraries.js", import.meta.url),
    "utf8",
  );
  const tracked = await trackedQuickJS();
  const engine = tracked.engine;
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
  const sendFunction = context.newFunction(
    "__sendRequest",
    (payload, callback) => {
      if (finalizing)
        return { error: context.newError("输出序列化期间不允许新增异步任务") };
      if (!workerData.input.allowNetwork)
        return { error: context.newError("此脚本未启用HTTP网络能力") };
      if (context.typeof(callback) !== "function")
        return { error: context.newError("脚本HTTP需要回调函数") };
      if (requestCount >= workerData.requestLimit || callbacks.size >= 4)
        return { error: context.newError("脚本HTTP最多10次、同时4次") };
      const json = context.getString(payload);
      if (json.length > 65536)
        return { error: context.newError("脚本HTTP请求超过64KiB") };
      const id = ++requestCount;
      callbacks.set(id, callback.dup());
      parentPort.postMessage({ kind: "http", id, payload: json });
      return context.undefined;
    },
  );
  context.setProp(context.global, "__sendRequest", sendFunction);
  sendFunction.dispose();

  const scheduleTimer = context.newFunction(
    "__scheduleTimer",
    (callback, delay) => {
      if (finalizing)
        return { error: context.newError("输出序列化期间不允许新增异步任务") };
      if (context.typeof(callback) !== "function")
        return { error: context.newError("定时器需要回调函数") };
      const milliseconds = context.getNumber(delay);
      if (
        !Number.isFinite(milliseconds) ||
        milliseconds < 0 ||
        milliseconds > 1000
      )
        return { error: context.newError("定时器延迟须为0至1000毫秒") };
      if (timerCount >= workerData.timerLimit || timers.size >= 32)
        return { error: context.newError("脚本定时器最多100次、同时32次") };
      const id = ++timerCount;
      timers.set(id, {
        callback: callback.dup(),
        due: Date.now() + milliseconds,
      });
      return context.newNumber(id);
    },
  );
  const cancelTimer = context.newFunction("__cancelTimer", (handle) => {
    const id = context.getNumber(handle),
      timer = timers.get(id);
    if (timer) {
      timers.delete(id);
      timer.callback.dispose();
    }
    return context.undefined;
  });
  context.setProp(context.global, "__scheduleTimer", scheduleTimer);
  context.setProp(context.global, "__cancelTimer", cancelTimer);
  scheduleTimer.dispose();
  cancelTimer.dispose();

  let fakerCalls = 0;
  const fakerFunction = context.newFunction("__fakerVariable", (keyHandle) => {
    if (++fakerCalls > workerData.fakerLimit)
      return { error: context.newError("Faker变量最多1000次") };
    try {
      const value = fakerVariable(context.getString(keyHandle));
      return value === undefined
        ? context.undefined
        : context.newString(JSON.stringify(value));
    } catch (error) {
      return { error: context.newError(error.message) };
    }
  });
  context.setProp(context.global, "__fakerVariable", fakerFunction);
  fakerFunction.dispose();

  const setup = `
    const input = ${JSON.stringify(workerData.input)};
    const pendingTasks=new Set();
    const trackTask=value=>{
      if(value && typeof value.then==='function'){
        if(pendingTasks.size>=1000)throw Error('异步回调最多1000个');
        const task=Promise.resolve(value);pendingTasks.add(task);
        task.then(()=>pendingTasks.delete(task),error=>{pendingTasks.delete(task);throw error;});
      }
    };
    const builtinVariable=(${builtinVariableFactory.toString()})(n=>JSON.parse(__randomBytes(n)),()=>Date.now(),((generate)=>key=>{const raw=generate(key);return raw===undefined?undefined:JSON.parse(raw);})(__fakerVariable));
    delete globalThis.__fakerVariable;
    ((schedule,cancel)=>{
    globalThis.setTimeout=(callback,delay=0,...args)=>{
      if(typeof callback!=='function')throw Error('定时器需要回调函数');
      return schedule(()=>{
        const result=callback(...args);
        trackTask(result);
      },Number(delay));
    };
    globalThis.clearTimeout=id=>cancel(Number(id));
    })(__scheduleTimer,__cancelTimer);
    delete globalThis.__scheduleTimer;
    delete globalThis.__cancelTimer;
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
      if(name === 'lodash') return globalThis._;
      if(name === 'moment') return globalThis.moment;
      if(name === 'uuid') return globalThis.uuid;
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
    let visualization = input.visualization ?? null;
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
      test: (name, fn) => {
        const record={name,passed:false,error:'异步断言未调用done完成'};
        tests.push(record);
        let called=false, failed=false;
        const fail=error=>{failed=true;record.passed=false;record.error=String(error?.message ?? error).slice(0,4000);};
        const done=error=>{
          if(called){fail(Error('异步断言done不能重复调用'));return;}
          called=true;
          if(error){fail(error);return;}
          if(!failed){record.passed=true;delete record.error;}
        };
        try {
          const asynchronous=fn.length>0;
          const result=asynchronous?fn(done):fn();
          if(result && typeof result.then==='function'){
            if(asynchronous)throw Error('异步断言不能混用Promise与done');
            record.error='Promise异步断言未完成';
            Promise.resolve(result).then(()=>done(),fail);
          } else if(!asynchronous && !failed){record.passed=true;delete record.error;}
        } catch(error){fail(error);}
        return pm;
      },
      expect: actual => ({ to: { equal: expected => { if (actual !== expected) throw Error('Expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); } } })
    };
    const visualizer = {
      set: (template, data) => {
        if (!response) throw Error('响应可视化仅支持后置脚本');
        visualization = __renderVisualization(template, data);
      },
      clear: () => { visualization = null; }
    };
    apt.visualizer = visualizer;
    pm.visualizer = visualizer;
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
  scriptStage = "compatibility";
  deadline = Date.now() + workerData.activityBudgetMs;
  run("pm.expect = chai.expect; apt.expect = chai.expect; apt.test = pm.test;");
  run(
    "(" +
      scriptCompatibilitySource +
      ")({request,response,pm,apt,variables,localVariables,tests,parameterName,modifyPair,builtinVariable,executionContext:input.executionContext,maxTests:" +
      workerData.assertionLimit +
      "});",
  );

  run("(" + responseCompatibilitySource + ")({response,pm,apt});");
  run(
    "globalThis.csv2array = (()=>{const parse=" +
      parseCSVRows.toString() +
      ";return function csv2array(text){if(arguments.length!==1)throw Error('CSV仅支持单个文本参数');return parse(text);};})();",
  );

  run(`pm.sendRequest=(config,callback)=>{
    if(callback===undefined)return new Promise((resolve,reject)=>pm.sendRequest(config,(error,response)=>error?reject(error):resolve(response)));
    if(typeof callback !== 'function')throw Error('pm.sendRequest回调须为函数');
    const captured={...variables,...localVariables};
    __sendRequest(JSON.stringify({request:config,variables:captured}),(errorJSON,responseJSON)=>{
      const error=errorJSON?new Error(errorJSON):null, data=responseJSON?JSON.parse(responseJSON):null;
      const headers=data?.headers||{};
      const response=data?{code:data.status,status:data.statusText,responseTime:data.duration,json:()=>JSON.parse(data.body),text:()=>data.body,headers:{get:name=>headers[String(name).toLowerCase()],has:name=>Object.prototype.hasOwnProperty.call(headers,String(name).toLowerCase()),toObject:()=>JSON.parse(JSON.stringify(headers))}}:null;
      const result=callback(error,response);
      trackTask(result);
    });
  };apt.sendRequest=pm.sendRequest;`);
  run("(" + ajaxCompatibilitySource + ")(pm.sendRequest);");
  let remaining = deadline - Date.now();
  const bounded = (fn) => {
    if (remaining <= 0) throw Error("脚本执行超时");
    const start = Date.now();
    deadline = start + remaining;
    try {
      return fn();
    } finally {
      remaining -= Date.now() - start;
    }
  };
  scriptStage = "script";
  for (const [index, code] of [
    library,
    "(async()=>{\n" + workerData.code + "\n})()",
  ].entries()) {
    const result = bounded(() => context.evalCode(code));
    if (result.error) {
      const error = context.dump(result.error);
      result.error.dispose();
      throw Error(error.message || JSON.stringify(error));
    }
    if (index === 1) rootPromise = result.value;
    else result.value.dispose();
  }

  let jobCount = 0;
  const drainJobs = () => {
    while (runtime.hasPendingJob()) {
      if (jobCount >= workerData.jobLimit) throw Error("脚本微任务最多10000次");
      const result = bounded(() =>
        runtime.executePendingJobs(
          Math.min(100, workerData.jobLimit - jobCount),
        ),
      );
      if (result.error) {
        result.error.dispose();
        throw Error("脚本微任务执行失败或超时");
      }
      jobCount += result.value;
    }
    const rootState = bounded(() => context.getPromiseState(rootPromise));
    if (rootState.type === "fulfilled") rootState.value.dispose();
    else if (rootState.type === "rejected") {
      rootState.error.dispose();
      throw Error("脚本Promise被拒绝: " + tracked.unhandledMessage());
    }
  };
  drainJobs();
  scriptStage = "async-completion";
  while (callbacks.size || timers.size) {
    const earliest = Math.min(
      ...[...timers.values()].map((timer) => timer.due),
    );
    if (!replies.length && earliest > Date.now())
      await new Promise((resolve) => {
        let timeout;
        wake = () => {
          clearTimeout(timeout);
          resolve();
        };
        if (Number.isFinite(earliest))
          timeout = setTimeout(
            () => {
              wake = null;
              resolve();
            },
            Math.max(0, earliest - Date.now()),
          );
      });
    for (const message of replies.splice(0)) {
      const callback = callbacks.get(message.id);
      if (!callback) continue;
      callbacks.delete(message.id);
      const error = context.newString(message.error || ""),
        response = context.newString(
          message.response ? JSON.stringify(message.response) : "",
        );
      try {
        const result = bounded(() =>
          context.callFunction(callback, context.undefined, error, response),
        );
        if (result.error) {
          const value = context.dump(result.error);
          result.error.dispose();
          throw Error(value.message || JSON.stringify(value));
        }
        result.value.dispose();
        drainJobs();
      } finally {
        callback.dispose();
        error.dispose();
        response.dispose();
      }
    }
    const now = Date.now();
    for (const [id, timer] of [...timers].sort(
      (a, b) => a[1].due - b[1].due || a[0] - b[0],
    )) {
      if (timer.due > now || !timers.has(id)) continue;
      timers.delete(id);
      try {
        const result = bounded(() =>
          context.callFunction(timer.callback, context.undefined),
        );
        if (result.error) {
          const value = context.dump(result.error);
          result.error.dispose();
          throw Error(value.message || JSON.stringify(value));
        }
        result.value.dispose();
        drainJobs();
      } finally {
        timer.callback.dispose();
      }
    }
    drainJobs();
  }
  bounded(() =>
    run("if(pendingTasks.size)throw Error('异步回调Promise未完成')"),
  );
  if (tracked.unhandledCount())
    throw Error("未处理的Promise拒绝: " + tracked.unhandledMessage());
  const rootState = bounded(() => context.getPromiseState(rootPromise));
  if (rootState.type === "pending") throw Error("脚本Promise未完成");
  if (rootState.type === "fulfilled") rootState.value.dispose();
  else if (rootState.type === "rejected") {
    rootState.error.dispose();
    throw Error("脚本Promise被拒绝");
  }
  const serializationStart = Date.now();
  deadline = serializationStart + Math.max(0, remaining);
  scriptStage = "serialization";
  finalizing = true;
  const output = context.evalCode(
    "applyLegacyVariables(scopeState, effectiveScopes(scopeState), variables); JSON.stringify({variables: effectiveScopes(scopeState), scopes: scopeState, localVariables, request, logs, tests, visualization})",
  );
  if (output.error) {
    output.error.dispose();
    throw Error("脚本输出不可序列化");
  }
  const json = context.getString(output.value);
  output.value.dispose();
  if (runtime.hasPendingJob() || tracked.unhandledCount())
    throw Error("输出序列化期间产生异步任务或未处理的Promise拒绝");
  if (Buffer.byteLength(json, "utf8") > 1024 * 1024)
    throw Error("脚本输出超过 1 MiB");
  outcome = {
    result: {
      ...JSON.parse(json),
      usage: { timers: timerCount, fakerCalls, jobs: jobCount },
      activityMs:
        workerData.activityBudgetMs -
        remaining +
        Date.now() -
        serializationStart,
    },
  };
} catch (error) {
  outcome = { error: error.message, scriptStage };
} finally {
  parentPort.off("message", receive);
  for (const callback of callbacks.values()) callback.dispose();
  for (const timer of timers.values()) timer.callback.dispose();
  rootPromise?.dispose();
  context?.dispose();
  runtime?.dispose();
}

parentPort.postMessage(outcome);
parentPort.close();
