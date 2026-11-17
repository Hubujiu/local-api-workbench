import test from "node:test";
import assert from "node:assert/strict";
import {
  validateAttributeDefinitions,
  validateAttributeValues,
} from "../public/attribute-model.js";
import { exportDocumentation } from "../public/document-export.js";
const fields = [
  { key: "owner", label: "负责人", type: "string" },
  { key: "count", label: "数量", type: "number" },
  { key: "choice", label: "优先级", type: "select", options: ["low", "high"] },
  {
    key: "many",
    label: "模块",
    type: "multiselect",
    options: [
      { value: "api", label: "接口" },
      { value: "ui", label: "界面" },
    ],
  },
  { key: "due", label: "日期", type: "date" },
  { key: "home", label: "链接", type: "url" },
  { key: "mail", label: "邮箱", type: "email" },
  { key: "enabled", label: "启用", type: "boolean" },
];
test("attribute definitions and values cover documented types with strict choices and safe links", () => {
  validateAttributeDefinitions(fields);
  validateAttributeValues(
    {
      owner: "测试",
      count: 0,
      choice: "high",
      many: ["api", "ui"],
      due: "2026-10-18",
      home: "https://example.test",
      mail: "owner@example.test",
      enabled: false,
    },
    fields,
  );
  assert.throws(
    () => validateAttributeValues({ choice: "missing" }, fields),
    /选项/,
  );
  assert.throws(
    () => validateAttributeValues({ many: ["api", "missing"] }, fields),
    /选项/,
  );
  assert.throws(
    () => validateAttributeValues({ due: "2026-02-30" }, fields),
    /日期/,
  );
  assert.throws(
    () => validateAttributeValues({ home: "javascript:alert(1)" }, fields),
    /链接/,
  );
  assert.throws(
    () => validateAttributeValues({ mail: "not-email" }, fields),
    /邮箱/,
  );
  assert.throws(
    () => validateAttributeDefinitions([...fields, fields[0]]),
    /重复/,
  );
});
test("documentation attributes are opt-in and apply to API and Markdown records without exposing unselected values", () => {
  const project = {
    name: "attributes",
    settings: { attributes: fields },
    documents: [
      {
        title: "Doc",
        content: "# hello",
        attributes: { mail: "doc@example.test", owner: "private doc owner" },
      },
    ],
    requests: [
      {
        name: "API",
        method: "GET",
        url: "https://example.test",
        bodyType: "none",
        examples: [],
        attributes: {
          mail: "api@example.test",
          owner: "private api owner",
          many: ["api"],
        },
      },
    ],
  };
  assert(!exportDocumentation(project, "html").includes("api@example.test"));
  const html = exportDocumentation(project, "html", {
    attributeKeys: ["mail", "many"],
  });
  assert(html.includes("api@example.test"));
  assert(html.includes("doc@example.test"));
  assert(!html.includes("private api owner"));
  assert(!html.includes("private doc owner"));
  assert(
    exportDocumentation(project, "markdown", {
      attributeKeys: ["mail"],
    }).includes("api@example.test"),
  );
});
