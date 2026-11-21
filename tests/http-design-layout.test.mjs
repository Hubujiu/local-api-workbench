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

const begin = "/* HTTP design scope: begin */";
const end = "/* HTTP design scope: end */";

function checkDesignStyles(css) {
  const [before, rest, ...duplicateBegin] = css.split(begin);
  assert.ok(
    rest !== undefined && !duplicateBegin.length,
    "one start marker required",
  );
  const [region, after, ...duplicateEnd] = rest.split(end);
  assert.ok(
    after !== undefined && !duplicateEnd.length && !before.includes(end),
    "one end marker required after start",
  );

  let selectors = 0;
  let start = 0;
  let body = false;
  const groups = [];
  let quote = "";
  const checkSelector = (stop) => {
    const selector = region.slice(start, stop).trim();
    assert.match(selector, /^\.http-design-page(?=$|[\s>.:#\[])/, selector);
    selectors++;
  };

  for (let i = 0; i < region.length; i++) {
    const char = region[i];
    if (char === "\\") {
      i++;
    } else if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (region.startsWith("/*", i)) {
      const close = region.indexOf("*/", i + 2);
      assert.notEqual(close, -1, "unclosed CSS comment");
      if (!body && !region.slice(start, i).trim()) start = close + 2;
      i = close + 1;
    } else if (char === "(" || char === "[") {
      groups.push(char === "(" ? ")" : "]");
    } else if (char === ")" || char === "]") {
      assert.equal(groups.pop(), char, "unbalanced CSS group");
    } else if (!groups.length) {
      if (body && char === "}") {
        start = i + 1;
        body = false;
      } else if (!body && (char === "," || char === "{")) {
        checkSelector(i);
        start = i + 1;
        body = char === "{";
      } else if (!body && ["+", "~", "|"].includes(char)) {
        assert.fail(
          "top-level sibling or column combinators are not allowed in design styles",
        );
      } else if (char === "{" || char === "}" || (!body && char === ";")) {
        assert.fail("expected flat HTTP design rules");
      }
    }
  }
  assert.ok(selectors > 0, "HTTP design rules missing");
  assert.ok(
    !body && !groups.length && !quote && !region.slice(start).trim(),
    "unfinished CSS rule",
  );
}

test("HTTP design styles cannot change debugging or protocol surfaces", async () => {
  const css = await readFile(
    new URL("../public/style.css", import.meta.url),
    "utf8",
  );
  checkDesignStyles(css);
});

test("HTTP design scope checks every sibling selector and stops at its boundary", () => {
  const css = (region) =>
    `${begin}\n${region}\n${end}\n.editor > .urlbar { display: none; }`;
  assert.doesNotThrow(() =>
    checkDesignStyles(
      css(
        '.http-design-page:is(.tab, #editor) > [data-name="a,b"], /* comment, { */\n' +
          '.http-design-page :not(.dark, .hidden) { content: "}, \\""; }',
      ),
    ),
  );
  for (const rule of [
    ".http-design-page .field, .urlbar { display: none; }",
    '.http-design-page:is(.tab, #editor), input[data-name="a,b"] { display: none; }',
    ".http-design-page-other { display: none; }",
    ".http-design-page + .response { display: none; }",
    ".http-design-page { & .field, .urlbar { display: none; } }",
  ])
    assert.throws(() => checkDesignStyles(css(rule)), {
      name: "AssertionError",
    });
  assert.throws(() => checkDesignStyles(".http-design-page { color: red; }"), {
    name: "AssertionError",
  });
});
