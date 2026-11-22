import assert from "node:assert/strict";
import test from "node:test";
import {
  createGlobalParameterDraft,
  globalParameterWorkspaceIssue,
  readGlobalParameterDraft,
  workspaceGlobalParametersHTML,
} from "../public/workspace-global-parameters.js";
import { applyGlobalParameters } from "../src/global-parameters.mjs";

test("workspace parameter changes preserve disabled state, order, textual values, and unedited fields", () => {
  const original = {
    headers: [
      { key: "X-First", value: "one" },
      { key: "X-Pause", value: "two", enabled: false },
    ],
    query: [{ key: "search", value: "A\r\nB" }],
    form: [{ key: "row", value: "1" }],
  };
  const before = structuredClone(original);
  const draft = createGlobalParameterDraft(original);
  draft.form[0].valueText = JSON.stringify("Ω\r\n{{value}}");
  const next = readGlobalParameterDraft(original, draft);
  assert.deepEqual(original, before);
  assert.deepEqual(next, {
    ...original,
    form: [{ key: "row", value: "Ω\r\n{{value}}" }],
  });
  assert(!Object.hasOwn(next.headers[0], "enabled"));
  assert(!Object.hasOwn(next, "cookies"));
  assert.deepEqual(
    readGlobalParameterDraft(undefined, createGlobalParameterDraft(undefined)),
    {},
  );
  const row = { key: "Scope", value: "keep" };
  const project = {
    settings: {
      globalParameters: next,
      folderParameters: { Test: { headers: [row] } },
    },
  };
  const parsed = applyGlobalParameters(project, {
    folder: "Test",
    bodyType: "urlencoded",
  });
  assert.deepEqual(parsed.headers, [
    { ...original.headers[0], enabled: true },
    { ...row, enabled: true },
  ]);
  assert.equal(parsed.form[0].value, "Ω\r\n{{value}}");
  assert.equal(
    applyGlobalParameters(project, { bodyType: "json" }).form,
    undefined,
  );
  assert.deepEqual(
    applyGlobalParameters(project, { inheritGlobalParameters: false }),
    { inheritGlobalParameters: false },
  );
});

test("unsupported native and metadata scopes are explicitly read-only", () => {
  assert.match(
    globalParameterWorkspaceIssue({ nativeInheritance: {} }),
    /保留了原生继承图/,
  );
  const source = {
    headers: [
      { key: "Source", value: "link", description: "keep", future: true },
    ],
  };
  const snapshot = structuredClone(source);
  const issue = globalParameterWorkspaceIssue({ globalParameters: source });
  assert.match(issue, /不会|不覆盖/);
  assert.throws(() => createGlobalParameterDraft(source), /仅接受/);
  assert.doesNotMatch(
    workspaceGlobalParametersHTML(issue),
    /role="tab"|添加参数/,
  );
  assert.deepEqual(source, snapshot);
});

test("validation stays strict for actual types, duplicate headers and Cookie syntax", () => {
  const draft = createGlobalParameterDraft(undefined);
  draft.headers.push({ key: "X-Dup", valueText: '"existing"', enabled: false });
  draft.headers.push({ key: "x-dup", valueText: "5", enabled: true });
  assert.throws(() => readGlobalParameterDraft(undefined, draft), /必须是文本/);
  draft.headers[1].valueText = '"safe"';
  assert.throws(() => readGlobalParameterDraft(undefined, draft), /参数名重复/);
  draft.headers.pop();
  draft.cookies.push({ key: "bad;name", valueText: '"val"', enabled: false });
  assert.throws(
    () => readGlobalParameterDraft(undefined, draft),
    /Cookie 名称或值无效/,
  );
  assert.doesNotMatch(
    workspaceGlobalParametersHTML(""),
    /role="tab"[^>]*>认证|role="tab"[^>]*>预执行/,
  );
});
