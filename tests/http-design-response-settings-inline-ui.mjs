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
const dir = await mkdtemp(join(tmpdir(), "workbench-inline-response-"));
const app = await createApp({ root: dir, port: 0 });
const origin = new URL(app.launchUrl).origin;
const forbidden = [],
  errors = [],
  writes = [];
let browser;
try {
  let owner = await app.store.create("Inline response settings fixture");
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
              content: { "application/json": { schema: { type: "object" } } },
            },
            404: {
              description: "失败",
              headers: {
                "X-Fixture": { schema: { type: "string" }, example: "outer" },
              },
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { message: { type: "string" } },
                  },
                  examples: {
                    missing: {
                      summary: "Bound example",
                      value: { message: "missing" },
                    },
                  },
                },
                "text/plain": { schema: { type: "string" }, example: "keep" },
              },
            },
          },
        },
      },
    },
  });
  fixture.id = "fixture";
  fixture.examples.push({
    name: "Independent example",
    status: 404,
    body: "independent",
    headers: { "content-type": "text/plain" },
    delayMs: 37,
  });
  owner.requests = [
    fixture,
    normalizeRequest({
      id: "other",
      name: "Other",
      url: "http://127.0.0.1:38982/other",
      responses: [{ status: "404", description: "Other unchanged" }],
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
  const view = (name) => section.getByRole("button", { name, exact: true });
  const form = section.getByRole("form", { name: "响应定义设置", exact: true });
  const status = form.getByRole("textbox", { name: "HTTP 状态", exact: true });
  const label = form.getByRole("textbox", { name: "响应说明", exact: true });
  const apply = form.getByRole("button", { name: "应用响应设置", exact: true });
  const cancel = form.getByRole("button", { name: "取消", exact: true });
  const raw = section.locator("#response-definitions");
  const save = page.locator("#save-project");
  const toast = page.locator("#toast");
  const focus = (el) => el.evaluate((node) => node === document.activeElement);
  const capture = async (label) => {
    const target = process.env.DESIGN_RESPONSE_SETTINGS_INLINE_EVIDENCE;
    if (!target) return;
    await mkdir(target, { recursive: true });
    await form.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(target, "design-response-settings-" + label + ".png"),
      caret: "hide",
      animations: "disabled",
    });
  };

  await page.locator('[data-mode="design"]').press("Enter");
  await page.locator("#design-description summary").press("Enter");
  await page.getByRole("tab", { name: "Query", exact: true }).press("Enter");
  await tab("200").press("ArrowRight");
  assert.equal(await tab("404").getAttribute("aria-selected"), "true");
  await view("期望设置").press("Enter");
  assert.equal(await status.inputValue(), "404");
  assert.equal(await label.inputValue(), "失败");
  assert.equal(
    await form.getByRole("status", { name: "内容格式" }).textContent(),
    "application/json · text/plain",
  );
  assert.match(
    await form.getByRole("status", { name: "示例延迟" }).textContent(),
    /Independent example：37 ms/,
  );
  assert.equal(await apply.isDisabled(), true);
  const desktop = await form
    .locator(".design-response-settings")
    .evaluate((node) =>
      [...node.children].map((item) => {
        const { x, y, width } = item.getBoundingClientRect();
        return { x, y, width };
      }),
    );
  console.log("DESIGN_RESPONSE_SETTINGS_DESKTOP", JSON.stringify(desktop));
  assert.equal(new Set(desktop.map((item) => Math.round(item.y))).size, 1);
  await capture("404-desktop");
  const base = await raw.inputValue();

  await status.fill("200");
  await status.press("Enter");
  assert.match(await toast.textContent(), /此响应状态已存在/);
  assert.equal(await raw.inputValue(), base);
  await tab("404").press("ArrowLeft");
  assert.match(await toast.textContent(), /未应用/);
  assert.equal(await tab("404").getAttribute("aria-selected"), "true");
  await save.press("Enter");
  assert.match(await toast.textContent(), /未应用/);
  assert.deepEqual(writes, []);
  await cancel.press("Enter");
  assert.equal(await status.inputValue(), "404");
  assert.equal(await focus(status), true);

  await label.fill("temporary name");
  await label.press("Escape");
  assert.equal(await label.inputValue(), "失败");
  const oldLabel = await label.elementHandle();
  await page.locator('[data-request="other"]').click();
  await oldLabel.evaluate((node) => {
    node.value = "stale";
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator('[data-request="fixture"]').click();
  assert.equal(await label.inputValue(), "失败");
  assert.equal(await apply.isDisabled(), true);

  await label.fill("Pending settings");
  const editedRaw = JSON.parse(base);
  editedRaw[1].description = "Competing JSON draft";
  const rawDraft = JSON.stringify(editedRaw, null, 2);
  await raw.fill(rawDraft);
  await apply.press("Enter");
  assert.match(await toast.textContent(), /设置或 JSON 草稿已变化/);
  await cancel.press("Enter");
  assert.equal(await raw.inputValue(), rawDraft);
  await raw.fill(base);

  await page.setViewportSize({ width: 430, height: 830 });
  const narrow = await form
    .locator(".design-response-settings > *")
    .evaluateAll((nodes) =>
      nodes.map((item) => {
        const { x, y, width } = item.getBoundingClientRect();
        return { x, y, width };
      }),
    );
  console.log("DESIGN_RESPONSE_SETTINGS_NARROW", JSON.stringify(narrow));
  assert(narrow[2].y > narrow[0].y);
  assert(narrow.every(({ x, width }) => x >= 0 && x + width <= 430));
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  await capture("404-narrow");

  await status.fill("422");
  await label.fill("Unprocessable fixture");
  await apply.press("Enter");
  assert.equal(await tab("422").getAttribute("aria-selected"), "true");
  assert.equal(await focus(status), true);
  assert.deepEqual(JSON.parse(await raw.inputValue())[0], JSON.parse(base)[0]);
  assert.deepEqual(JSON.parse(await raw.inputValue())[1], {
    ...JSON.parse(base)[1],
    status: "422",
    description: "Unprocessable fixture",
  });
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
  assert.deepEqual(stored.requests[1], baseline.requests[1]);
  assert.deepEqual(
    stored.requests[0].responses[0],
    baseline.requests[0].responses[0],
  );
  assert.equal(
    stored.requests[0].openapiExampleSources.filter(
      (source) => String(source.status) === "422",
    ).length,
    baseline.requests[0].openapiExampleSources.length,
  );
  const independent = (project) =>
    project.requests[0].examples.find(
      (ex) => ex.name === "Independent example",
    );
  assert.deepEqual(independent(stored), independent(baseline));
  await page.reload();
  await page.locator('[data-mode="design"]').press("Enter");
  await tab("422").press("Enter");
  await view("期望设置").press("Enter");
  assert.equal(await label.inputValue(), "Unprocessable fixture");
  assert.deepEqual(forbidden, [], "no send or unexpected project writes");
  assert.deepEqual(errors, []);
  console.log(
    "DESIGN_RESPONSE_SETTINGS_INLINE_UI_PASS exact selection, cancel/reject, persisted bindings and one deliberate save",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
