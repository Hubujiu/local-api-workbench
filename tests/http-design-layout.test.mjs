import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const source = await readFile(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);
const start = source.indexOf(
  '  if (mode === "design")',
  source.indexOf("function modePanel"),
);
const render = new Function(
  "r",
  "project",
  "esc",
  "importedScriptTasksHTML",
  "attributeFields",
  `const mode = "design"; ${source.slice(start, source.indexOf('  if (mode === "mock")', start))}`,
);
const esc = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");
const request = {
  description: "<description>",
  folder: "folder",
  timeout: 3000,
  schema: { type: "object", properties: { name: { type: "string" } } },
  responses: [],
  tls: {
    ca: "CA",
    proxyCa: "PROXY",
    cert: "CERT",
    key: "KEY",
    passphrase: "secret",
  },
};
const html = render(
  request,
  { servers: [] },
  esc,
  () => "",
  () => "",
);

test("HTTP design layout retains editable schema and all existing settings", () => {
  for (const id of [
    "description",
    "folder",
    "timeout",
    "request-proxy",
    "request-service",
    "inherit-global-parameters",
    "schema",
    "visual-schema",
    "new-response-schema",
    "response-definitions",
  ])
    assert.equal(html.split(`id="${id}"`).length, 2, id);
  for (const field of ["ca", "proxyCa", "cert", "key", "passphrase"])
    assert.equal(html.split(`data-tls="${field}"`).length, 2, field);
  assert.match(html, /&lt;description>/);
  assert.match(html, /&quot;properties&quot;/);
  assert.match(html, /TLS 校验始终开启/);
  assert.ok(html.indexOf('id="schema"') < html.indexOf('id="timeout"'));
  assert.ok(
    html.indexOf('id="response-definitions"') < html.indexOf('id="timeout"'),
  );
});

test("design is a real schema editor, not a fabricated inline field tree", () => {
  assert.match(html, /class="page http-design-page"/);
  assert.match(html, /aria-label="请求 JSON Schema"/);
  assert.match(html, /可视化编辑结构/);
  assert.doesNotMatch(html, /data-tab=|data-param=|data-body-type=/);
  for (const tag of ["div", "section"])
    assert.equal(
      (html.match(new RegExp(`<${tag}[ >]`, "g")) || []).length,
      (html.match(new RegExp(`</${tag}>`, "g")) || []).length,
      tag,
    );
});

test("HTTP design styles cannot change debugging or protocol surfaces", async () => {
  const css = await readFile(
    new URL("../public/style.css", import.meta.url),
    "utf8",
  );
  const scoped = css.slice(css.indexOf("\n.http-design-page {"));
  for (const rule of scoped.split("}").filter((value) => value.trim()))
    assert.ok(rule.trim().startsWith(".http-design-page"), rule);
});
