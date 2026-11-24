import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeRequest,
  prepareLiteralHTTPExport,
  toCurl,
} from "../src/core.mjs";
import { assertActiveFormFileEncoding } from "../src/form-wire-guard.mjs";
import { generateRequestCode } from "../src/request-code-generation.mjs";
import { executeRequest } from "../src/runtime.mjs";

const field = { key: "fixture-row", value: "fixture-data" };
const asRequest = (bodyType, row) => ({
  bodyType,
  form: [{ ...field, ...row }],
  method: "POST",
  url: "http://127.0.0.1:1/never-dispatch",
});
const urlencoded = /URLencoded 表单仅支持文本/;
const multipart = /multipart 文本字段仍带有文件标记/;
const rejectCases = [
  ["urlencoded", { type: "file" }, urlencoded],
  ["urlencoded", { type: "text", filename: "fixture-name" }, urlencoded],
  ["urlencoded", { requiresFile: true }, urlencoded],
  ["form-data", { type: "text", filename: "fixture-name" }, multipart],
  ["form-data", { requiresFile: true }, multipart],
];

test("active forms reject inconsistent modes with a generic actionable diagnostic", () => {
  for (const [mode, row, reason] of rejectCases) {
    const input = asRequest(mode, row);
    assert.throws(
      () => assertActiveFormFileEncoding(input),
      (error) =>
        reason.test(error.message) &&
        !/fixture-(?:name|data|row)/.test(error.message),
    );
  }
});

test("compatible and inactive rows remain unchanged", () => {
  for (const request of [
    asRequest("urlencoded", {
      type: "text",
      filename: "",
      requiresFile: false,
    }),
    asRequest("urlencoded", { filename: undefined, requiresFile: false }),
    asRequest("form-data", {
      type: "text",
      filename: "",
      requiresFile: false,
      contentType: "text/plain",
    }),
    asRequest("form-data", {
      type: "file",
      filename: "fixture-name",
      requiresFile: false,
    }),
    asRequest("form-data", { type: "file", requiresFile: true }),
    asRequest("raw", { type: "file", requiresFile: true }),
    ...rejectCases.map(([mode, row]) =>
      asRequest(mode, { ...row, enabled: false }),
    ),
  ]) {
    const before = structuredClone(request);
    assert.doesNotThrow(() => assertActiveFormFileEncoding(request));
    assert.deepEqual(request, before);
  }
});

test("definition normalization and JSON cloning keep even inconsistent rows intact", () => {
  for (const [mode, row] of rejectCases) {
    const input = asRequest(mode, row);
    assert.deepEqual(normalizeRequest(input).form, input.form);
    assert.deepEqual(
      normalizeRequest(JSON.parse(JSON.stringify(input))).form,
      input.form,
    );
  }
});

test("runtime uses the preflight after normalization and before its abort check (never dispatches)", async () => {
  const aborted = AbortSignal.abort(
    new Error("fixture is blocked before transport"),
  );
  for (const [mode, row, reason] of rejectCases)
    await assert.rejects(executeRequest(asRequest(mode, row), aborted), reason);
  await assert.rejects(
    executeRequest(
      asRequest("urlencoded", { filename: "", requiresFile: false }),
      aborted,
    ),
    { name: "AbortError" },
  );
});

test("literal cURL and code share the normalized guard without changing ordinary export limits", () => {
  for (const [mode, row, reason] of rejectCases) {
    const input = asRequest(mode, row);
    assert.throws(() => prepareLiteralHTTPExport(input), reason);
    assert.throws(() => toCurl(input), reason);
    assert.throws(() => generateRequestCode(input, "node", "fetch"), reason);
  }
  assert.match(
    toCurl(asRequest("urlencoded", { filename: "", requiresFile: false })),
    /--data-raw/,
  );
  assert.match(
    toCurl(
      asRequest("form-data", { filename: "fixture-name", enabled: false }),
    ),
    /--data-binary/,
  );
  assert.throws(
    () =>
      toCurl(
        asRequest("form-data", {
          type: "file",
          filename: "fixture-name",
          enabled: false,
        }),
      ),
    /文件或内联证书请求需手工配置/,
  );
});
