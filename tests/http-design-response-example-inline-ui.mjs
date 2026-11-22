import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import {
  exportOpenAPI,
  importDocument,
  normalizeRequest,
} from "../src/core.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const dir = await mkdtemp(join(tmpdir(), "workbench-response-example-"));
const app = await createApp({ root: dir, port: 0 });
const origin = new URL(app.launchUrl).origin;
const forbidden = [],
  errors = [],
  writes = [];
const json = "application/json";
const problem = "application/problem+json";
let browser;
try {
  let owner = await app.store.create("Inline response example fixture");
  const [fixture] = importDocument({
    openapi: "3.1.0",
    info: { title: "Fixture", version: "1" },
    servers: [{ url: "http://127.0.0.1:38982" }],
    paths: {
      "/verification": {
        get: {
          summary: "Verification",
          responses: {
            200: {
              description: "成功",
              content: { [json]: { schema: { type: "boolean" } } },
            },
            404: {
              description: "失败",
              content: {
                [json]: {
                  schema: {
                    type: ["object", "null"],
                    properties: {
                      message: {
                        type: "string",
                        pattern: "^fixture",
                        minLength: 7,
                      },
                      related: { $ref: "#/components/schemas/Local" },
                    },
                    required: ["message"],
                    "x-fixture": "preserve",
                  },
                  examples: {
                    bound: {
                      summary: "Verification example",
                      "x-fixture": "original",
                      value: { message: "fixture missing" },
                    },
                  },
                },
                [problem]: {
                  schema: { type: "array", items: { type: "integer" } },
                },
                "text/plain": { schema: { type: "string" } },
              },
            },
          },
        },
      },
    },
    components: { schemas: { Local: { type: "string" } } },
  });
  fixture.id = "fixture";
  fixture.examples.push(
    {
      name: "Verification example",
      status: 404,
      body: "  [1]  ",
      headers: { "content-type": json, "x-fixture": "preserve" },
      delayMs: 37,
    },
    {
      name: "Plain",
      status: 404,
      body: "unchanged",
      headers: { "content-type": "text/plain" },
    },
  );
  owner.requests = [
    fixture,
    normalizeRequest({
      id: "other",
      name: "Other",
      url: "http://127.0.0.1:38982/other",
      responses: [
        {
          status: "404",
          description: "Other unchanged",
          content: { [json]: {} },
        },
      ],
    }),
  ];
  owner = await app.store.save(owner);
  const baseline = structuredClone(await app.store.get(owner.id));
  const original = baseline.requests[0];
  const boundIndex = original.examples.findIndex(
    (row) => row.openapiExampleSource,
  );
  const independentIndex = original.examples.findIndex(
    (row) => row.delayMs === 37,
  );
  assert.notEqual(boundIndex, -1);
  assert.notEqual(independentIndex, -1);

  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
  });
  const savePath = "/api/projects/" + owner.id;
  let maySave = false;
  await page.addInitScript(
    (id) => sessionStorage.setItem("project", id),
    owner.id,
  );
  page.on("pageerror", () => errors.push("unexpected renderer error"));
  await page.route("**/*", (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.origin === origin && req.method() === "GET")
      return route.continue();
    if (
      maySave &&
      !writes.length &&
      url.origin === origin &&
      req.method() === "PUT" &&
      url.pathname === savePath
    ) {
      writes.push(req.postDataJSON());
      return route.continue();
    }
    forbidden.push(req.method());
    return route.abort();
  });
  await page.goto(app.launchUrl);
  const section = page.getByRole("region", {
    name: "设计响应参数",
    exact: true,
  });
  const tab = (status) =>
    section.getByRole("tab", { name: new RegExp(status) });
  const view = (name) => section.getByRole("button", { name, exact: true });
  const form = section.getByRole("form", { name: "行内响应示例", exact: true });
  const body = form.getByRole("textbox", {
    name: "JSON 示例正文",
    exact: true,
  });
  const pick = section.getByRole("combobox", { name: "当前示例", exact: true });
  const media = section.getByRole("combobox", {
    name: "响应 Content-Type",
    exact: true,
  });
  const raw = section.locator("#response-definitions");
  const save = page.locator("#save-project");
  const toast = page.locator("#toast");
  const focus = (el) => el.evaluate((node) => node === document.activeElement);
  const capture = async (label) => {
    const target = process.env.DESIGN_RESPONSE_EXAMPLE_INLINE_EVIDENCE;
    if (!target) return;
    await mkdir(target, { recursive: true });
    await form.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(target, "design-response-example-" + label + ".png"),
      caret: "hide",
      animations: "disabled",
    });
  };
  const openExamples = async () => {
    await page.locator('[data-mode="design"]').press("Enter");
    await view("示例").press("Enter");
  };

  await openExamples();
  await page.locator("#design-description summary").press("Enter");
  await page.getByRole("tab", { name: "Query", exact: true }).press("Enter");
  await tab("404").press("Enter");
  assert.equal(
    await body.count(),
    0,
    "ambiguous same-name JSON examples require an explicit choice",
  );
  assert.deepEqual(await pick.locator("option").allTextContents(), [
    "选择要编辑的示例",
    "1. Verification example",
    "2. Verification example",
    "新示例正文",
  ]);

  await media.selectOption(problem);
  assert.equal(await body.inputValue(), "");
  assert.equal(await view("添加示例到草稿").isDisabled(), true);
  const desktop = await body.boundingBox();
  console.log("DESIGN_RESPONSE_EXAMPLE_DESKTOP", JSON.stringify(desktop));
  assert(desktop.width > 750 && desktop.height >= 140);
  await capture("blank-desktop");
  const base = await raw.inputValue();
  await body.fill("{");
  await view("添加示例到草稿").press("Enter");
  assert.match(await toast.textContent(), /JSON 响应示例正文无效/);
  await tab("404").press("ArrowLeft");
  assert.equal(await tab("404").getAttribute("aria-selected"), "true");
  await media.selectOption(json);
  assert.equal(await media.inputValue(), problem);
  assert.match(await toast.textContent(), /示例正文有未应用/);
  await body.press("Escape");
  assert.equal(await focus(body), true);
  assert.equal(await body.inputValue(), "");

  const newText = "\n [-1, 0, 1]  \n";
  await body.fill(newText);
  await view("添加示例到草稿").press("Enter");
  assert.equal(await body.inputValue(), newText);
  assert.equal(await view("应用示例正文").isDisabled(), true);
  assert.equal(await raw.inputValue(), base);
  const old = await body.elementHandle();

  await media.selectOption("text/plain");
  assert.equal(await body.count(), 0);
  assert.equal(await view("＋ 新建示例").count(), 0);
  await media.selectOption(json);
  await pick.selectOption(String(boundIndex));
  assert.equal(await body.inputValue(), original.examples[boundIndex].body);
  await old.evaluate((node) => {
    node.value = "true";
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.equal(await view("应用示例正文").isDisabled(), true);
  await body.fill("false");
  await pick.selectOption(String(independentIndex));
  assert.equal(await pick.inputValue(), String(boundIndex));
  await page.locator('[data-request="other"]').click();
  assert.equal(await body.inputValue(), "false");
  await save.press("Enter");
  assert.match(await toast.textContent(), /示例正文有未应用/);
  assert.deepEqual(writes, []);

  const changedRaw = JSON.parse(base);
  changedRaw[1].description = "Competing draft";
  const rawDraft = JSON.stringify(changedRaw, null, 2);
  await raw.fill(rawDraft);
  await view("应用示例正文").press("Enter");
  assert.match(await toast.textContent(), /示例或 JSON 草稿已变化/);
  await view("取消").press("Enter");
  assert.equal(await raw.inputValue(), rawDraft);
  await raw.fill(base);
  const boundBody = "\n null \n";
  await body.fill(boundBody);
  await view("应用示例正文").press("Enter");
  assert.equal(await body.inputValue(), boundBody);
  assert.equal(await focus(body), true);
  await capture("bound-desktop");

  await pick.selectOption(String(independentIndex));
  assert.equal(
    await body.inputValue(),
    original.examples[independentIndex].body,
  );
  await page.setViewportSize({ width: 430, height: 830 });
  const narrow = await body.boundingBox();
  console.log("DESIGN_RESPONSE_EXAMPLE_NARROW", JSON.stringify(narrow));
  assert(narrow.x >= 0 && narrow.x + narrow.width <= 430);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  await body.fill("false");
  await body.press("Escape");
  assert.equal(
    await body.inputValue(),
    original.examples[independentIndex].body,
  );
  await capture("bound-narrow");
  assert.deepEqual(await app.store.get(owner.id), baseline);

  maySave = true;
  const [response] = await Promise.all([
    page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === savePath &&
        res.request().method() === "PUT",
    ),
    save.press("Enter"),
  ]);
  assert.equal(response.status(), 200);
  await page.getByText("✓ 已保存", { exact: true }).waitFor();
  maySave = false;
  assert.equal(writes.length, 1);
  const stored = await app.store.get(owner.id);
  const result = stored.requests[0];
  const savedBound = result.examples[boundIndex];
  assert.deepEqual(savedBound, {
    ...original.examples[boundIndex],
    body: boundBody,
  });
  assert.equal(Object.hasOwn(savedBound, "delayMs"), false);
  assert.deepEqual(
    result.examples.filter((_, i) => i !== boundIndex).slice(0, -1),
    original.examples.filter((_, i) => i !== boundIndex),
  );
  assert.deepEqual(result.examples.at(-1), {
    name: "响应示例",
    status: 404,
    headers: { "content-type": problem },
    body: newText,
  });
  assert.deepEqual(result.responses, original.responses);
  assert.deepEqual(
    result.openapiExampleSources,
    original.openapiExampleSources,
  );
  assert.deepEqual(stored.requests[1], baseline.requests[1]);
  const exported = exportOpenAPI({ ...stored, requests: [result] }).paths[
    "/verification"
  ].get.responses[404].content;
  assert.deepEqual(exported[json].examples.bound, {
    summary: "Verification example",
    "x-fixture": "original",
    value: null,
  });
  assert.deepEqual(exported[problem].examples.example_1.value, [-1, 0, 1]);

  await page.reload();
  await openExamples();
  await tab("404").press("Enter");
  await media.selectOption(json);
  await pick.selectOption(String(boundIndex));
  assert.equal(await body.inputValue(), boundBody);
  assert.deepEqual(
    forbidden,
    [],
    "no Mock, live send or unexpected project writes",
  );
  assert.deepEqual(errors, []);
  console.log(
    "DESIGN_RESPONSE_EXAMPLE_INLINE_UI_PASS one deliberate save, no dispatch",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
