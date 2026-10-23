import test from "node:test";
import assert from "node:assert/strict";
import MarkdownIt from "markdown-it";
import { exportDocumentation } from "../public/document-export.js";

const project = () => ({
  name: "Docs",
  documents: [],
  requests: [
    {
      name: "Upload",
      method: "POST",
      url: "http://localhost/upload",
      description: "",
      bodyType: "form-data",
      body: "",
      query: [
        {
          key: "page",
          value: "1",
          enabled: false,
          required: true,
          description: "page description",
        },
      ],
      path: [],
      headers: [{ key: "x-test", value: "test" }],
      form: [
        {
          key: "name|<b>",
          value: "first\nsecond",
          enabled: false,
          required: true,
          description: "**literal**",
        },
        {
          key: "upload",
          type: "file",
          filename: "chosen<.txt",
          value: "SECRET-UPLOAD-BYTES",
          requiresFile: true,
          enabled: true,
        },
      ],
      schema: false,
      responses: [
        {
          status: "201",
          description: "created",
          content: { "application/json": { schema: { type: "boolean" } } },
        },
      ],
      examples: [],
    },
  ],
});

test("HTML and Markdown documentation include form fields, parameter state and schemas without uploaded file contents", () => {
  const source = project(),
    before = structuredClone(source);
  for (const format of ["html", "markdown"]) {
    const output = exportDocumentation(source, format);
    assert(output.includes("name"), format);
    assert(output.includes("page description"), format);
    assert(output.includes("停用"), format);
    assert(output.includes("必填"), format);
    assert(output.includes("chosen&lt;"), format);
    assert(output.includes("待重新选择"), format);
    assert(output.includes("false"), format);
    assert(output.includes("created"), format);
    assert(!output.includes("SECRET-UPLOAD-BYTES"), format);
  }
  const html = exportDocumentation(source, "html");
  assert(html.includes("name|&lt;b&gt;"));
  assert(!html.includes("<b>"));
  const md = new MarkdownIt({ html: true }).render(
    exportDocumentation(source, "markdown"),
  );
  assert(md.includes("name|&lt;b&gt;"));
  assert(md.includes("**literal**"));
  assert(!md.includes("<b>"));
  assert.deepEqual(source, before);
});

test("literal request and response bodies cannot terminate Markdown code fences or become active markup", () => {
  const source = project(),
    request = source.requests[0];
  source.name = "<script>bad()</script>";
  request.name = "![bad](https://example.invalid/name)";
  request.bodyType = "raw";
  request.body =
    'start\n```\n<img src="https://example.invalid/body">\n``````\nend';
  request.examples = [
    {
      name: "<img src=x>",
      status: 200,
      body: "```\n<script>bad()</script>\n~~~",
    },
  ];
  const markdown = exportDocumentation(source, "markdown");
  const parser = new MarkdownIt({ html: true });
  const rendered = parser.render(markdown);
  assert(!rendered.includes("<img "));
  assert(!rendered.includes("<script>"));
  const bodies = parser
    .parse(markdown, {})
    .filter((token) => token.type === "fence")
    .map((token) => token.content);
  assert(bodies.includes(request.body + "\n"));
  assert(bodies.includes(request.examples[0].body + "\n"));
});

test("empty forms are explicit and urlencoded examples preserve zero false empty and multiline values", () => {
  const source = project(),
    request = source.requests[0];
  request.bodyType = "urlencoded";
  request.form = [];
  for (const format of ["html", "markdown"])
    assert(exportDocumentation(source, format).includes("无表单项"));
  request.form = [
    { key: "zero", value: 0 },
    { key: "false-value", value: false },
    { key: "empty", value: "" },
    { key: "multi", value: "a\nb" },
  ];
  const html = exportDocumentation(source, "html");
  assert.match(html, /zero[\s\S]*>0</);
  assert.match(html, /false-value[\s\S]*>false</);
  const rendered = new MarkdownIt({ html: true }).render(
    exportDocumentation(source, "markdown"),
  );
  assert(rendered.includes("a<br>b"));
  assert(rendered.includes("empty"));
});

test("managed documentation uses current examples without resurrecting source bodies and keeps external metadata and descriptions", () => {
  const source = project(),
    request = source.requests[0];
  request.openapiExampleBindingsVersion = 1;
  request.responses = [
    {
      status: "200",
      content: {
        "application/json": {
          schema: { type: "string" },
          examples: {
            removed: { value: "deleted-only" },
            kept: { value: "old-value", description: "Kept description" },
            external: { externalValue: "https://example.invalid/source" },
          },
        },
      },
    },
  ];
  request.examples = [
    {
      name: "Current",
      status: 201,
      body: '"new-value"',
      headers: { "x-test": "metadata" },
      delayMs: 0,
      openapiExampleSource: {
        kind: "examples",
        status: "200",
        mediaType: "application/json",
        key: "kept",
      },
    },
  ];
  const before = structuredClone(source);
  for (const format of ["html", "markdown"]) {
    const output = exportDocumentation(source, format);
    assert(output.includes("new-value"));
    assert(!output.includes("old-value"));
    assert(!output.includes("deleted-only"));
    assert(output.includes("Kept description"));
    assert(output.includes("https://example.invalid/source"));
    assert(output.includes("x-test"));
    assert(output.includes("Mock 延迟：0"));
  }
  assert.deepEqual(source, before);
});

test("documentation preserves empty body versus a single newline and preview uses the same form rendering", async () => {
  const source = project(),
    request = source.requests[0];
  request.bodyType = "raw";
  request.body = "";
  request.schema = undefined;
  request.responses = [];
  request.examples = [{ name: "newline", status: 200, body: "\n" }];
  const blocks = new MarkdownIt()
    .parse(exportDocumentation(source, "markdown"), {})
    .filter((t) => t.type === "fence");
  assert.deepEqual(
    blocks.map((t) => t.content),
    ["", "\n"],
  );
  const { requestDocumentationHTML } = await import(
    "../public/document-export.js"
  );
  const form = project().requests[0];
  const preview = requestDocumentationHTML(form, 4);
  assert(preview.includes("chosen&lt;"));
  assert(preview.includes("停用"));
  assert(!preview.includes("SECRET-UPLOAD-BYTES"));
  assert.throws(() => requestDocumentationHTML(form, 0), /标题层级/);
});

test("empty response definitions remain an explicit section in shared and exported documentation", async () => {
  const source = project();
  source.requests[0].responses = [];
  for (const format of ["html", "markdown"]) {
    const output = exportDocumentation(source, format);
    assert(output.includes("响应定义"));
    assert(output.includes("未配置响应结构"));
  }
  const { requestDocumentationHTML } = await import(
    "../public/document-export.js"
  );
  assert(
    requestDocumentationHTML(source.requests[0], 4).includes("未配置响应结构"),
  );
});
