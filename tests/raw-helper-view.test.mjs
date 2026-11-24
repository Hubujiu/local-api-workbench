import assert from "node:assert/strict";
import test from "node:test";
import { resolveDynamicRequest } from "../src/dynamic-values.mjs";
import { interpolate } from "../src/core.mjs";
import { debugEnvironment } from "../src/environments.mjs";
import { effectiveScopes, projectScopes } from "../src/variable-scopes.mjs";
import { effectiveParameterDictionary } from "../public/dictionary-view.js";
import {
  matchesRawHelperEntry,
  bodyDynamicToken,
  rawHelperFixedValue,
  rawHelperMockChooser,
  rawHelperMockPreset,
  rawHelperTabs,
  rawHelperVariableChooser,
  rawHelperVariableNames,
} from "../public/raw-helper-view.js";

const entry = {
  id: 'id" data-test="escape',
  key: "RequestId",
  note: "手工输入",
  description: "描述 <img src=x>",
  type: "string",
  default: "non-searchable value",
};
const initial = { tab: "dictionary", query: "" };

test("Raw helper search matches only actual parameter names, notes, or descriptions", () => {
  for (const query of ["", "  requestid  ", "输入", "描述"])
    assert(matchesRawHelperEntry(entry, query));
  for (const query of ["string", "non-searchable value", "absent"])
    assert(!matchesRawHelperEntry(entry, query));
});

test("Raw helper defaults to dictionary and never creates project rows", () => {
  const disabled = {
    settings: { builtinDictionary: false },
    parameterDictionary: [],
  };
  const html = rawHelperTabs(
    effectiveParameterDictionary(disabled),
    "<h4>真实功能</h4>",
    initial,
  );
  assert.match(html, /当前项目暂无字典参数/);
  assert.doesNotMatch(html, /data-insert-dictionary/);
  assert.match(
    html,
    /data-raw-helper-tab="dictionary"[^>]*aria-selected="true"/,
  );
  assert.match(html, /id="raw-helper-dynamic"[^>]*hidden/);
  assert.match(html, /真实功能/);
});

test("Raw helper escapes project-owned text and omits sample/default values from the markup", () => {
  const html = rawHelperTabs([entry], "", { ...initial, query: "<absent>" });
  assert.match(html, /RequestId/);
  assert.match(html, /手工输入/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.doesNotMatch(
    html,
    /<img| id="id" data-test="escape|non-searchable value/,
  );
  assert.match(html, /value="&lt;absent&gt;"/);
  assert.match(
    html,
    /data-insert-dictionary="id&quot; data-test=&quot;escape"/,
  );
  assert.match(html, /没有匹配的字典参数/);
});

test("variable options read only names and prioritize the active environment", () => {
  const neverRead = () => {
    throw Error("secret value accessor invoked");
  };
  const globals = { duplicate: "private global", globalName: "private value" };
  Object.defineProperty(globals, "privateName", {
    enumerable: true,
    get: neverRead,
  });
  const selected = { duplicate: "private env", activeName: "private value" };
  Object.defineProperty(selected, "quoted'Name", {
    enumerable: true,
    get: neverRead,
  });
  const entries = rawHelperVariableNames(
    {
      globalVariables: globals,
      environments: [
        { id: "active", variables: selected },
        { id: "other", variables: { unrelatedName: "private value" } },
      ],
    },
    "active",
  );
  assert.deepEqual(
    entries.map((entry) => [entry.name, entry.scope]),
    [
      ["duplicate", "环境变量"],
      ["globalName", "全局变量"],
      ["privateName", "全局变量"],
      ["activeName", "环境变量"],
      ["quoted'Name", "环境变量"],
    ],
  );
  const html = rawHelperVariableChooser(entries);
  assert.doesNotMatch(
    html,
    /private value|private env|unrelatedName|telephone/,
  );
  assert.match(html, /quoted&#39;Name/);
  assert.match(rawHelperVariableChooser([]), /当前项目没有可引用的变量/);
});

test("fixed chooser preview agrees with the existing no-transform body token contract", async () => {
  const id = "owned-fixed-draft";
  const text = '  local "fixed" 中文 {{ordinary text}}  ';
  const { preview, spec } = rawHelperFixedValue(text);
  const draft = {
    url: "http://127.0.0.1:38982/verification",
    method: "POST",
    bodyType: "json",
    body: bodyDynamicToken(id),
    bodyDynamic: { [id]: spec },
  };
  const savedDraft = structuredClone(draft);
  const resolved = await resolveDynamicRequest(draft, {}, [], interpolate);
  assert.equal(resolved.body, preview);
  assert.equal(JSON.parse(resolved.body), text);
  assert.deepEqual(draft, savedDraft);
  assert.deepEqual(spec, {
    source: "fixed",
    value: text,
    format: "json",
    functions: [],
  });
});

test("fixed chooser rejects missing and oversized serialized values before insertion", () => {
  assert.equal(rawHelperFixedValue(""), null);
  assert.equal(rawHelperFixedValue(undefined), null);
  assert(rawHelperFixedValue("x".repeat(65534)));
  assert.equal(rawHelperFixedValue("x".repeat(65535)), null);
  assert.equal(rawHelperFixedValue("中".repeat(22000)), null);
});

test("variable names are read only from the current owned request and its live collection", () => {
  const neverRead = () => {
    throw Error("unrelated or secret value accessor invoked");
  };
  const request = { postmanCollectionId: "own" };
  const picked = {
    id: "own",
    variables: {
      collectionWinner: "value",
      envWinner: "loses",
      onlyCollection: "value",
    },
  };
  Object.defineProperty(picked, "definitions", {
    enumerable: true,
    get: neverRead,
  });
  Object.defineProperty(picked.variables, "noValueRead", {
    enumerable: true,
    get: neverRead,
  });
  const unrelated = { id: "other" };
  Object.defineProperty(unrelated, "variables", {
    enumerable: true,
    get: neverRead,
  });
  const project = {
    requests: [request],
    postmanCollections: { items: [unrelated, picked] },
    globalVariables: {
      onlyGlobal: "value",
      collectionWinner: "loses",
      envWinner: "loses",
    },
    environments: [
      { id: "active", variables: { envWinner: "value", onlyEnv: "value" } },
    ],
  };
  const labels = Object.fromEntries(
    rawHelperVariableNames(project, "active", request).map(
      ({ name, scope }) => [name, scope],
    ),
  );
  assert.deepEqual(labels, {
    onlyGlobal: "全局变量",
    collectionWinner: "集合变量",
    envWinner: "环境变量",
    onlyCollection: "集合变量",
    noValueRead: "集合变量",
    onlyEnv: "环境变量",
  });
  assert.throws(
    () => rawHelperVariableNames(project, "active", { ...request }),
    /不属于此项目/,
  );
  project.postmanCollections.items = [unrelated];
  assert.throws(
    () => rawHelperVariableNames(project, "active", request),
    /集合不可用/,
  );
});

test("chooser winners match the real Debug environment and scope precedence without dispatch", () => {
  const request = { postmanCollectionId: "own" };
  const collectionVariables = {
    collectionWinner: "collection",
    envWinner: "collection",
    onlyCollection: "collection",
  };
  const project = {
    id: "owned-helper-fixture",
    requests: [request],
    globalVariables: {
      onlyGlobal: "global",
      collectionWinner: "global",
      envWinner: "global",
    },
    environments: [
      {
        id: "active",
        variables: { envWinner: "environment", onlyEnv: "environment" },
      },
    ],
    postmanCollections: {
      items: [
        {
          id: "own",
          variables: collectionVariables,
          definitions: Object.fromEntries(
            Object.keys(collectionVariables).map((key) => [
              key,
              { type: "string" },
            ]),
          ),
        },
      ],
    },
  };
  const debug = debugEnvironment(
    project,
    "active",
    new Map(),
    request.postmanCollectionId,
  );
  const scopes = effectiveScopes(
    projectScopes(
      project,
      debug.environment.id,
      debug.variables,
      request.postmanCollectionId,
    ),
  );
  const scopeLabels = {
    global: "全局变量",
    collection: "集合变量",
    environment: "环境变量",
  };
  const expected = Object.fromEntries(
    Object.entries(scopes).map(([name, value]) => [name, scopeLabels[value]]),
  );
  assert.deepEqual(
    { ...scopes },
    {
      onlyGlobal: "global",
      collectionWinner: "collection",
      envWinner: "environment",
      onlyCollection: "collection",
      onlyEnv: "environment",
    },
  );
  const actual = Object.fromEntries(
    rawHelperVariableNames(project, "active", request).map(
      ({ name, scope }) => [name, scope],
    ),
  );
  assert.deepEqual(actual, expected);
});

test("every advertised Raw Mock rule produces its claimed type through the real body resolver", async () => {
  const checks = {
    integer: (v) => Number.isInteger(v) && v >= 1 && v <= 100,
    boolean: (v) => typeof v === "boolean",
    date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v),
    datetime: (v) => /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(v),
    uuid: (v) =>
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        v,
      ),
    url: (v) => /^https:\/\/example\.test\/[a-z]{8}$/.test(v),
    ip: (v) => /^192\.0\.2\.\d{1,3}$/.test(v),
    email: (v) => /^user\d+@example\.test$/.test(v),
    cname: (v) => /^\p{Script=Han}{2,4}$/u.test(v),
    name: (v) => /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(v),
    word: (v) => /^[a-z]{8}$/.test(v),
  };
  const markup = rawHelperMockChooser();
  const ids = [...markup.matchAll(/data-raw-mock-rule="([a-z]+)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(ids.sort(), Object.keys(checks).sort());
  for (const id of ids) {
    const preset = rawHelperMockPreset(id);
    assert.deepEqual(preset.spec.functions, []);
    assert.equal(preset.spec.source, "mock");
    assert.equal(preset.spec.format, "json");
    assert.equal(Object.hasOwn(preset.spec, "seed"), false);
    const draft = {
      url: "http://127.0.0.1:38982/verification",
      method: "POST",
      bodyType: "json",
      body: bodyDynamicToken(id),
      bodyDynamic: { [id]: { ...preset.spec, seed: 31672608 } },
    };
    const snapshot = structuredClone(draft);
    const out = await resolveDynamicRequest(draft, {}, [], interpolate);
    assert(checks[id](JSON.parse(out.body)), id);
    assert.deepEqual(draft, snapshot);
  }
  for (const id of ["now", "time", "@integer(1,999)", "constructor", "execute"])
    assert.equal(rawHelperMockPreset(id), null);
  assert.doesNotMatch(markup, /@now\(|@time\(|Mock\.js|示例密码/);
});
