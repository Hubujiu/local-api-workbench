import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportOpenAPI, normalizeRequest } from "../src/core.mjs";
import { createApp } from "../src/server.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const storage = await mkdtemp(join(tmpdir(), "workbench-query-metadata-"));
const app = await createApp({ root: storage, port: 0 });
const origin = new URL(app.launchUrl).origin;
const denied = [],
  errors = [],
  writes = [];
const constrained = {
  key: "fixture_uuid",
  value: "",
  enabled: true,
  schema: { type: "string", format: "uuid" },
};
let browser;
try {
  let owner = await app.store.create("Query metadata synthetic");
  owner.requests = [
    normalizeRequest({
      id: "verification",
      name: "Verification",
      url: "http://127.0.0.1:38982/verification",
    }),
    normalizeRequest({
      id: "other",
      name: "Other",
      url: "http://127.0.0.1:38982/other",
      query: [constrained],
    }),
  ];
  owner = await app.store.save(owner);
  const baseline = structuredClone(await app.store.get(owner.id));
  const allowedPath = "/api/projects/" + owner.id;
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
  });
  await page.addInitScript(
    (id) => sessionStorage.setItem("project", id),
    owner.id,
  );
  page.on("pageerror", () => errors.push("unexpected application error"));
  let maySave = false;
  await page.route("**/*", (route) => {
    const req = route.request(),
      u = new URL(req.url());
    if (u.origin === origin && req.method() === "GET") return route.continue();
    if (
      maySave &&
      !writes.length &&
      u.origin === origin &&
      u.pathname === allowedPath &&
      req.method() === "PUT"
    ) {
      writes.push(req.postDataJSON());
      return route.continue();
    }
    denied.push(req.method());
    return route.abort();
  });
  await page.goto(app.launchUrl);
  const mode = (p) => page.locator(`[data-mode="${p}"]`);
  const designTab = (n) => page.getByRole("tab", { name: n, exact: true });
  const panel = page.locator("#design-parameter-panel");
  const request = (id) => page.locator(`[data-request="${id}"]`);
  const selectType = (name, type) =>
    panel.getByRole("button", {
      name: "更改 " + name + " 的类型：" + type,
      exact: true,
    });
  const required = panel.getByRole("button", {
    name: "ui_fixture 必填",
    exact: true,
  });
  const rowEnabled = panel.getByRole("checkbox", {
    name: "启用参数",
    exact: true,
  });
  const menu = page.getByRole("menu", { name: "Query 标量类型", exact: true });
  const option = (name) =>
    menu.getByRole("menuitemradio", { name, exact: true });
  const focus = (el) => el.evaluate((node) => document.activeElement === node);
  const capture = async (name) => {
    const dir = process.env.DESIGN_QUERY_METADATA_EVIDENCE;
    if (!dir) return;
    await mkdir(dir, { recursive: true });
    await page.screenshot({
      path: join(dir, "design-query-" + name + ".png"),
      caret: "hide",
      animations: "disabled",
    });
  };

  await mode("design").press("Enter");
  await designTab("Query").press("Enter");
  assert.equal(await panel.locator(".design-query-required").count(), 0);
  assert.equal(await panel.locator(".design-query-type").count(), 0);
  assert.equal(await rowEnabled.count(), 0);
  await panel
    .getByRole("textbox", { name: "新Query参数名", exact: true })
    .fill("ui_fixture");
  const string = selectType("ui_fixture", "string");
  await string.press("ArrowDown");
  assert.equal(await focus(option("string")), true);
  assert.equal(await option("string").getAttribute("aria-checked"), "true");
  assert.deepEqual(await menu.getByRole("menuitemradio").allTextContents(), [
    "string",
    "number",
    "integer",
    "boolean",
  ]);
  const window = await menu.boundingBox();
  const trigger = await string.boundingBox();
  console.log(
    "DESIGN_QUERY_TYPE_MENU_DESKTOP",
    JSON.stringify({ window, trigger }),
  );
  assert(Math.abs(window.x - (trigger.x + 6)) <= 2);
  assert(Math.abs(window.y - (trigger.y + trigger.height + 6)) <= 2);
  assert.equal(Math.round(window.width), 98);
  await capture("type-menu-desktop");
  await option("string").press("ArrowDown");
  await option("number").press("ArrowDown");
  await option("integer").press("Enter");
  const integer = selectType("ui_fixture", "integer");
  assert.equal(await focus(integer), true);
  assert.equal(await required.getAttribute("aria-pressed"), "false");
  await required.press("Space");
  assert.equal(await focus(required), true);
  assert.equal(await required.getAttribute("aria-pressed"), "true");
  await required.press("Space");
  assert.equal(await required.getAttribute("aria-pressed"), "false");
  assert.equal(await integer.isVisible(), true);
  await required.press("Space");
  await rowEnabled.uncheck();
  assert.equal(await rowEnabled.isChecked(), false);
  assert.equal(await required.getAttribute("aria-pressed"), "true");
  assert.equal(await integer.isVisible(), true);
  await capture("integer-required-disabled-desktop");

  await integer.press("Enter");
  const detachedChoice = await option("boolean").elementHandle();
  await request("other").click();
  await detachedChoice.evaluate((node) => node.click());
  const imported = selectType("fixture_uuid", "string");
  await imported.press("Enter");
  await option("integer").press("Enter");
  assert.match(
    await page.locator("#toast").textContent(),
    /保留现有约束、格式或示例/,
  );
  assert.equal(await imported.isVisible(), true);
  await request("verification").click();
  assert.equal(await integer.isVisible(), true);
  await designTab("Header").press("Enter");
  assert.equal(await panel.locator(".design-query-required").count(), 0);
  await designTab("Path").press("Enter");
  assert.equal(await panel.locator(".design-query-type").count(), 0);
  await mode("debug").press("Enter");
  await page.locator('[data-param="query"]').press("Enter");
  assert.equal(await page.locator(".design-query-required").count(), 0);
  await mode("design").press("Enter");
  await designTab("Query").press("Enter");

  await page.setViewportSize({ width: 430, height: 830 });
  await integer.press("Enter");
  const narrow = await menu.boundingBox();
  assert(
    narrow.x >= 8 &&
      narrow.x + narrow.width <= 422 &&
      narrow.y >= 8 &&
      narrow.y + narrow.height <= 822,
  );
  await capture("type-menu-narrow");
  await option("integer").press("Escape");
  assert.equal(await focus(integer), true);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  assert.deepEqual(await app.store.get(owner.id), baseline);

  maySave = true;
  const [saved] = await Promise.all([
    page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === allowedPath &&
        res.request().method() === "PUT",
    ),
    page.locator("#save-project").press("Enter"),
  ]);
  assert.equal(saved.status(), 200);
  await page.getByText("✓ 已保存", { exact: true }).waitFor();
  maySave = false;
  assert.equal(writes.length, 1);
  const config = await app.store.get(owner.id);
  assert.deepEqual(config.requests[0].query, [
    {
      key: "ui_fixture",
      value: "",
      enabled: false,
      required: true,
      schema: { type: "integer" },
    },
  ]);
  assert.deepEqual(config.requests[1].query, [constrained]);
  assert.equal(
    exportOpenAPI(config).paths["/verification"].get.parameters.length,
    0,
  );
  config.requests[0].query[0].enabled = true; // In-memory export projection only.
  const exported =
    exportOpenAPI(config).paths["/verification"].get.parameters[0];
  assert.equal(exported.required, true);
  assert.deepEqual(exported.schema, { type: "integer" });
  await page.reload();
  await mode("design").press("Enter");
  await designTab("Query").press("Enter");
  assert.equal(await integer.isVisible(), true);
  assert.equal(await required.getAttribute("aria-pressed"), "true");
  assert.equal(await rowEnabled.isChecked(), false);
  assert.deepEqual(denied, []);
  assert.deepEqual(errors, []);
  console.log(
    "DESIGN_QUERY_METADATA_UI_PASS scalar type/required/toggle, advanced rejection, 430, exact one local save, no dispatch",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(storage, { recursive: true, force: true });
}
