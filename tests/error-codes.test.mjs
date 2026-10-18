import test from "node:test";
import assert from "node:assert/strict";
import { parseErrorCodeList, validateErrorCodes } from "../src/error-codes.mjs";
import { exportDocumentation } from "../public/document-export.js";
test("error dictionary accepts business/string codes and preserves zero, negative and leading-zero identifiers", () => {
  const codes = parseErrorCodeList(
    '0: 成功\n-1: 未知错误\nAUTH_EXPIRED: 登录过期\n001: 保留前缀\n10001: "两行\\n说明"',
  );
  assert.deepEqual(
    codes.map((item) => item.code),
    [0, -1, "AUTH_EXPIRED", "001", 10001],
  );
  assert.equal(codes[4].label, "两行\n说明");
  validateErrorCodes(codes);
  assert.throws(
    () =>
      validateErrorCodes([
        { code: 1, label: "a" },
        { code: "1", label: "b" },
      ]),
    /重复/,
  );
  assert.throws(
    () => validateErrorCodes([{ code: "AUTH", label: "a", httpHint: true }]),
    /HTTP/,
  );
  assert.throws(() => parseErrorCodeList("没有分隔符"), /格式/);
});
test("HTML and Markdown documentation include the current dictionary with escaped data", () => {
  const project = {
    name: "Docs",
    requests: [],
    documents: [],
    settings: {
      statusCodes: [
        {
          code: "AUTH_EXPIRED",
          label: "token <script>alert(1)</script> | expired",
        },
      ],
    },
  };
  const html = exportDocumentation(project, "html");
  assert(html.includes("AUTH_EXPIRED"));
  assert(html.includes("&lt;script&gt;"));
  assert(!html.includes("<script>alert"));
  assert(exportDocumentation(project, "markdown").includes("AUTH\\_EXPIRED"));
  project.settings.statusCodes[0].label = "updated";
  assert(exportDocumentation(project, "html").includes("updated"));
});
