import assert from "node:assert/strict";
import test from "node:test";
import { variableRows } from "../public/variable-definitions.js";
import {
  globalVariableDraftRows,
  readWorkspaceGlobalVariableRows,
  workspaceGlobalVariablesHTML,
} from "../public/workspace-global-variables.js";

test("workspace globals keep current JSON types, definition-only entries, and untouched legacy fallback", () => {
  const current = { count: 2, mode: "preview", updated: false };
  const definitions = {
    count: { initialValue: 0, description: "keep count" },
    queued: {
      initialValue: { items: [1, null] },
      description: "unset current",
    },
  };
  const draft = globalVariableDraftRows(variableRows(current, definitions));
  draft.find((row) => row.key === "count").current = "3";
  draft.find((row) => row.key === "mode").current = '"review"';
  const next = readWorkspaceGlobalVariableRows(draft);
  assert.deepEqual(next, {
    values: { count: 3, mode: "review", updated: false },
    definitions,
  });
  assert.deepEqual(current, { count: 2, mode: "preview", updated: false });
  assert(!Object.hasOwn(next.definitions, "mode"));
  assert(!Object.hasOwn(next.values, "queued"));
});

test("explicit metadata edits or intentionally unsetting can create a separate initial value", () => {
  const draft = globalVariableDraftRows(
    variableRows({ candidate: 4, base: "plain" }),
  );
  draft[0].currentSet = false;
  draft[0].current = "invalid"; // a disabled current value never becomes executable data
  draft[1].description = "typed default";
  assert.deepEqual(readWorkspaceGlobalVariableRows(draft), {
    values: { base: "plain" },
    definitions: {
      candidate: { initialValue: 4, description: "" },
      base: { initialValue: "plain", description: "typed default" },
    },
  });
});

test("workspace globals fail atomically under the real JSON and variable map validators", () => {
  const draft = globalVariableDraftRows(
    variableRows({ sentinel: 1, neutral: "ok" }),
  );
  draft[1].current = "{";
  assert.throws(
    () => readWorkspaceGlobalVariableRows(draft),
    /第2行当前值不是有效JSON/,
  );
  draft[1].current = '"ok"';
  draft[1].key = "sentinel";
  assert.throws(() => readWorkspaceGlobalVariableRows(draft), /变量名重复/);
  draft[1].key = "__proto__";
  assert.throws(() => readWorkspaceGlobalVariableRows(draft), /变量名无效/);
  assert.match(workspaceGlobalVariablesHTML(), /搜索变量名、描述/);
  assert.match(workspaceGlobalVariablesHTML(), /保存项目.*才会写入本地/);
});
