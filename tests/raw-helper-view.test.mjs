import assert from "node:assert/strict";
import test from "node:test";
import { effectiveParameterDictionary } from "../public/dictionary-view.js";
import {
  matchesRawHelperEntry,
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
