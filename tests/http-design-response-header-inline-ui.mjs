import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { importDocument, normalizeRequest } from "../src/core.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const dir = await mkdtemp(join(tmpdir(), "workbench-response-header-"));
const app = await createApp({ root: dir, port: 0 });
const origin = new URL(app.launchUrl).origin;
const forbidden = [],
  errors = [],
  writes = [];
let browser;
try {
  let owner = await app.store.create("Inline response header fixture");
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
              content: {
                "application/json": {
                  schema: { type: "object" },
                  examples: { initial: { value: { message: "ready" } } },
                },
                "text/plain": { schema: { type: "string" } },
              },
            },
            404: {
              description: "失败",
              headers: {
                "X-Advanced": {
                  schema: { type: "array", items: { type: "integer" } },
                  example: [1, 2],
                  "x-fixture": "preserve",
                },
              },
            },
          },
        },
      },
    },
  });
  fixture.id = "fixture";
  fixture.examples.push({
    name: "Independent fallback",
    status: 200,
    body: "unchanged",
    headers: { "content-type": "text/plain" },
    delayMs: 37,
  });
  owner.requests = [
    fixture,
    normalizeRequest({
      id: "other",
      name: "Other",
      url: "http://127.0.0.1:38982/other",
      responses: [{ status: "200", description: "Other unchanged" }],
    }),
  ];
  owner = await app.store.save(owner);
  const baseline = structuredClone(await app.store.get(owner.id));
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
  const headerView = section.getByRole("button", {
    name: "Header",
    exact: true,
  });
  const view = (name) => section.getByRole("button", { name, exact: true });
  const field = (name) => section.getByRole("textbox", { name, exact: true });
  const name = field("响应头名称"),
    example = field("示例值"),
    description = field("描述");
  const apply = view("添加到草稿");
  const raw = section.locator("#response-definitions");
  const save = page.locator("#save-project");
  const toast = page.locator("#toast");
  const table = section.getByRole("table");
  const focus = (el) => el.evaluate((node) => node === document.activeElement);
  const capture = async (label) => {
    const target = process.env.DESIGN_RESPONSE_HEADER_INLINE_EVIDENCE;
    if (!target) return;
    await mkdir(target, { recursive: true });
    await table.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(target, "design-response-header-" + label + ".png"),
      caret: "hide",
      animations: "disabled",
    });
  };
  const bounds = () =>
    table
      .locator(".design-response-header-composer input")
      .evaluateAll((list) =>
        list.map((node) => {
          const { x, y, width, height } = node.getBoundingClientRect();
          return { x, y, width, height };
        }),
      );

  await page.locator('[data-mode="design"]').press("Enter");
  await page.locator("#design-description summary").press("Enter");
  await page.getByRole("tab", { name: "Query", exact: true }).press("Enter");
  await headerView.press("Enter");
  await name.focus();
  assert.equal(await apply.isDisabled(), true);
  const base = await raw.inputValue();
  await name.fill("  ");
  assert.equal(await apply.isDisabled(), true);
  assert.equal(await raw.inputValue(), base);
  const desktop = await bounds();
  console.log("DESIGN_RESPONSE_HEADER_DESKTOP", JSON.stringify(desktop));
  assert.equal(new Set(desktop.map(({ y }) => Math.round(y))).size, 1);
  assert(desktop.every(({ width, height }) => width > 220 && height >= 26));
  await name.fill("");
  await capture("desktop-empty");

  await name.fill("Content-Type");
  await name.press("Enter");
  assert.match(await toast.textContent(), /媒体类型/);
  await name.press("Escape");
  assert.equal(await focus(name), true);
  assert.equal(await name.inputValue(), "");

  await tab("404").press("Enter");
  await name.fill("x-advanced");
  await name.press("Enter");
  assert.match(await toast.textContent(), /同名响应头/);
  assert.equal(await raw.inputValue(), base);
  await name.press("Escape");
  await view("编辑响应头 X-Advanced").press("Enter");
  const modal = page.getByRole("dialog");
  const json = modal.getByRole("textbox", { name: "响应头定义 JSON" });
  assert.deepEqual(
    JSON.parse(await json.inputValue()),
    baseline.requests[0].responses[1].headers["X-Advanced"],
  );
  await json.press("Escape");
  await modal.waitFor({ state: "hidden" });
  await name.fill("X-After-Modal");
  assert.equal(await apply.isEnabled(), true);
  await name.press("Escape");

  await tab("200").press("Enter");
  const detached = await name.elementHandle();
  await name.fill("X-Pending");
  await tab("200").press("ArrowRight");
  assert.equal(await tab("200").getAttribute("aria-selected"), "true");
  assert.match(await toast.textContent(), /新增响应头有未应用/);
  await page.locator('[data-request="other"]').click();
  assert.equal(await name.inputValue(), "X-Pending");
  await save.press("Enter");
  assert.match(await toast.textContent(), /新增响应头有未应用/);
  assert.deepEqual(writes, []);
  const altered = JSON.parse(base);
  altered[0].description = "Raw edit";
  const rawDraft = JSON.stringify(altered, null, 2);
  await raw.fill(rawDraft);
  await apply.press("Enter");
  assert.match(await toast.textContent(), /响应头或 JSON 草稿已变化/);
  await view("取消").press("Enter");
  assert.equal(await raw.inputValue(), rawDraft);
  await name.fill("X-Blocked");
  assert.match(await toast.textContent(), /JSON 有未应用/);
  assert.equal(await name.inputValue(), "");
  await raw.fill(base);

  await page.locator('[data-request="other"]').click();
  await detached.evaluate((node) => {
    node.value = "X-Stale";
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator('[data-request="fixture"]').click();
  assert.equal(await name.inputValue(), "");
  await name.fill("X-UI-Fixture");
  await name.press("Tab");
  assert.equal(await focus(example), true);
  await example.fill("0");
  await example.press("Tab");
  assert.equal(await focus(description), true);
  await description.fill("UI fixture header");
  assert.equal(await raw.inputValue(), base);
  await description.press("Enter");
  assert(await view("编辑响应头 X-UI-Fixture").isVisible());
  assert.equal(await focus(name), true);
  assert.equal(await name.inputValue(), "");
  await capture("desktop-populated");
  const updated = JSON.parse(await raw.inputValue());
  assert.deepEqual(updated, [
    {
      ...JSON.parse(base)[0],
      headers: {
        "X-UI-Fixture": {
          schema: { type: "string" },
          example: "0",
          description: "UI fixture header",
        },
      },
    },
    JSON.parse(base)[1],
  ]);

  await page.setViewportSize({ width: 430, height: 830 });
  const narrow = await bounds();
  console.log("DESIGN_RESPONSE_HEADER_NARROW", JSON.stringify(narrow));
  assert(narrow.every(({ x, width }) => x >= 0 && x + width <= 430));
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  await name.fill("X-Discard");
  await name.press("Escape");
  assert.equal(await name.inputValue(), "");
  await capture("narrow-populated");
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
  const stored = await app.store.get(owner.id);
  assert.equal(writes.length, 1);
  assert.deepEqual(stored.requests[0].responses, updated);
  assert.deepEqual(stored.requests[0].examples, baseline.requests[0].examples);
  assert.deepEqual(
    stored.requests[0].openapiExampleSources,
    baseline.requests[0].openapiExampleSources,
  );
  assert.deepEqual(stored.requests[1], baseline.requests[1]);
  await page.reload();
  await page.locator('[data-mode="design"]').press("Enter");
  await tab("200").press("Enter");
  await headerView.press("Enter");
  assert(await view("编辑响应头 X-UI-Fixture").isVisible());
  assert.equal(await name.inputValue(), "");
  assert.deepEqual(forbidden, [], "no dispatch or unexpected project writes");
  assert.deepEqual(errors, []);
  console.log(
    "DESIGN_RESPONSE_HEADER_INLINE_UI_PASS one deliberate save, no dispatch",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
