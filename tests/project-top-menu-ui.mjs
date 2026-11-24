import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const evidence = process.env.PROJECT_TOP_MENU_EVIDENCE;
const root = await mkdtemp(join(tmpdir(), "workbench-project-top-menu-"));
const app = await createApp({ root, port: 0 });
let browser;
try {
  let owner = await app.store.create("默认项目");
  owner.requests = [
    normalizeRequest({
      id: "fixture",
      name: "Verification",
      method: "GET",
      url: "http://127.0.0.1:38982/no-send",
    }),
  ];
  owner = await app.store.save(owner);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
  });
  const origin = new URL(app.launchUrl).origin,
    blocked = [],
    errors = [];
  page.on("pageerror", () => errors.push("unexpected page error"));
  await page.route("**/*", (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (
      url.origin === origin &&
      request.method() === "GET" &&
      url.pathname !== "/mcp"
    )
      return route.continue();
    blocked.push(request.method());
    return route.abort();
  });
  await page.goto(app.launchUrl);
  await page.waitForFunction(
    (id) =>
      document.querySelector("#project-select option[selected]")?.value === id,
    owner.id,
  );
  const requestName = page.locator("#request-name");
  await requestName.fill("Owned unsaved draft");
  const trigger = page.locator("#new-project");
  const popup = page.getByRole("dialog", {
    name: "新建或导入项目",
    exact: true,
  });
  const create = popup.getByRole("button", { name: "新建项目", exact: true });
  const importProject = popup.getByRole("button", {
    name: "导入项目",
    exact: true,
  });
  const focused = (locator) =>
    locator.evaluate((node) => document.activeElement === node);
  const box = (locator) =>
    locator
      .boundingBox()
      .then((bounds) =>
        Object.fromEntries(
          Object.entries(bounds).map(([key, value]) => [
            key,
            Math.round(value),
          ]),
        ),
      );
  const open = async () => {
    await trigger.press("Enter");
    await popup.waitFor();
    assert.equal(await trigger.getAttribute("aria-expanded"), "true");
    assert(await focused(create));
  };
  const close = async (which) => {
    await page.keyboard.press("Escape");
    await which.waitFor({ state: "hidden" });
    assert(await focused(trigger));
  };
  const capture = async (label, clip) => {
    if (!evidence) return;
    await mkdir(evidence, { recursive: true });
    await page.screenshot({
      path: join(evidence, "project-top-menu-" + label + ".png"),
      caret: "hide",
      ...(clip ? { clip } : {}),
    });
  };
  await open();
  const desktop = {
    trigger: await box(trigger),
    popup: await box(popup),
    create: await box(create),
    import: await box(importProject),
  };
  console.log("PROJECT_TOP_MENU", "desktop", JSON.stringify(desktop));
  assert.equal(desktop.popup.x, desktop.trigger.x);
  assert.deepEqual(
    [desktop.popup.y, desktop.popup.width, desktop.popup.height],
    [45, 129, 82],
  );
  assert.equal(desktop.import.y - desktop.create.y, 32);
  await page.mouse.click(990, 150);
  await popup.waitFor({ state: "hidden" });
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  await trigger.click();
  await popup.waitFor();
  await capture("desktop", { x: 135, y: 0, width: 205, height: 140 });
  await close(popup);

  // No API sidebar/import button exists here; the top action must still work.
  await page.locator('.rail [data-page="history"]').press("Enter");
  await open();
  await create.press("ArrowDown");
  assert(await focused(importProject));
  await importProject.press("Enter");
  const importDialog = page.getByRole("dialog", {
    name: "导入项目（手动）",
    exact: true,
  });
  await importDialog.locator("#import-text").waitFor();
  await close(importDialog);
  assert(await page.locator(".recent-workspace").isVisible());
  await open();
  await create.press("Enter");
  const createDialog = page.getByRole("dialog", {
    name: "新建项目",
    exact: true,
  });
  await createDialog.locator("#new-description").waitFor();
  await close(createDialog);
  assert(await page.locator(".recent-workspace").isVisible());

  await page.setViewportSize({ width: 430, height: 760 });
  await open();
  const narrow = await box(popup);
  assert(narrow.x >= 8 && narrow.x + narrow.width <= 422);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  await capture("narrow");
  await close(popup);
  await page.setViewportSize({ width: 1363, height: 1023 });
  await page.locator('.rail [data-page="apis"]').press("Enter");
  assert.equal(await requestName.inputValue(), "Owned unsaved draft");
  assert.equal(await page.locator("#saved-state").textContent(), "● 未保存");
  assert.equal((await app.store.list()).length, 1);
  assert.equal(
    (await app.store.get(owner.id)).requests[0].name,
    "Verification",
  );
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  console.log(
    "PROJECT_TOP_MENU_UI_PASS two-real-actions/129x82/history/430/keyboard/owner-draft/zero-writes",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
