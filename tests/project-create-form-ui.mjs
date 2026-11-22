import { openProjectCreateUI } from "./helpers/open-project-create-ui.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const evidence = process.env.PROJECT_CREATE_FORM_EVIDENCE;
const root = await mkdtemp(join(tmpdir(), "workbench-project-create-form-"));
const directory = join(root, "custom project folder");
await mkdir(directory);
const app = await createApp({ root: join(root, "registry"), port: 0 });
let browser;
try {
  const source = await app.store.create("默认项目");
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
    errors = [],
    writes = [];
  let allowCreate = false;
  page.on("pageerror", () => errors.push("pageerror"));
  await page.addInitScript(() => {
    localStorage.setItem("theme", "light");
    window.desktop = {
      chooseDirectory() {
        return new Promise((resolve) => {
          window.pendingProjectDirectory = resolve;
        });
      },
    };
  });
  await page.route("**/*", (route) => {
    const req = route.request(),
      uri = new URL(req.url());
    if (
      uri.origin === origin &&
      req.method() === "GET" &&
      uri.pathname !== "/mcp"
    )
      return route.continue();
    if (
      uri.origin === origin &&
      req.method() === "POST" &&
      uri.pathname === "/api/projects" &&
      allowCreate
    ) {
      allowCreate = false;
      writes.push(req.postDataJSON());
      return route.continue();
    }
    blocked.push(req.method());
    return route.abort();
  });
  await page.goto(app.launchUrl);
  await page.waitForFunction(
    (id) =>
      document.querySelector("#project-select option[selected]")?.value === id,
    source.id,
  );
  const open = page.locator("#new-project"),
    dialog = page.getByRole("dialog", { name: "新建项目", exact: true });
  const name = dialog.getByRole("textbox", { name: "项目名称", exact: true });
  const path = dialog.getByRole("textbox", { name: "存储位置", exact: true });
  const desc = dialog.getByRole("textbox", { name: /项目描述/ });
  const pick = dialog.getByRole("button", { name: "选择位置", exact: true });
  const close = async () => {
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert(await open.evaluate((node) => node === document.activeElement));
  };
  const bounds = async (locator) => {
    const r = await locator.boundingBox();
    return Object.fromEntries(
      Object.entries(r).map(([key, value]) => [key, Math.round(value)]),
    );
  };
  const capture = async (label) => {
    if (!evidence) return;
    await mkdir(evidence, { recursive: true });
    await page.screenshot({
      path: join(evidence, "project-create-form-" + label + ".png"),
      caret: "hide",
    });
  };
  await openProjectCreateUI(page);
  await dialog.waitFor();
  const desktop = {
    frame: await bounds(dialog),
    name: await bounds(name),
    path: await bounds(path),
    choose: await bounds(pick),
    description: await bounds(desc),
  };
  console.log("PROJECT_CREATE_FORM", "desktop", JSON.stringify(desktop));
  await capture("desktop");
  assert.equal(desktop.frame.x, 482);
  assert.equal(desktop.frame.y, 314);
  assert.equal(desktop.frame.width, 600);
  assert.equal(desktop.frame.height, 395);
  assert.equal(desktop.name.y, 403);
  assert.equal(desktop.name.width, 560);
  assert.equal(desktop.name.height, 32);
  assert.equal(desktop.path.y, 486);
  assert.equal(desktop.path.y, desktop.choose.y);
  assert.equal(desktop.description.y, 570);
  assert.equal(desktop.description.width, 560);
  assert.equal(desktop.description.height, 71);
  assert(await name.evaluate((node) => node === document.activeElement));

  await pick.press("Enter");
  await page.waitForFunction(
    () => typeof window.pendingProjectDirectory === "function",
  );
  await close();
  await openProjectCreateUI(page);
  await path.fill("typed choice in reopened dialog");
  await page.evaluate(
    (value) => window.pendingProjectDirectory(value),
    directory,
  );
  await page.waitForFunction(
    () =>
      document.querySelector("#new-directory")?.value ===
      "typed choice in reopened dialog",
  );
  assert.equal(await path.inputValue(), "typed choice in reopened dialog");
  await close();
  assert.equal((await app.store.list()).length, 1);
  assert.deepEqual(writes, []);

  await page.setViewportSize({ width: 430, height: 760 });
  await openProjectCreateUI(page);
  await dialog.waitFor();
  const narrow = await bounds(dialog);
  assert(narrow.x >= 0 && narrow.x + narrow.width <= 430);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  await capture("narrow");
  await name.fill("Local create visual fixture");
  await name.press("Tab");
  assert(await path.evaluate((node) => node === document.activeElement));
  await path.press("Tab");
  assert(await pick.evaluate((node) => node === document.activeElement));
  await pick.press("Enter");
  await page.waitForFunction(
    () => document.querySelector("#pick-directory")?.disabled,
  );
  await page.evaluate(
    (value) => window.pendingProjectDirectory(value),
    directory,
  );
  await page.waitForFunction(
    (value) => document.querySelector("#new-directory")?.value === value,
    directory,
  );
  const description = "第一行：本机合成数据\nSecond line";
  await desc.fill(description);
  allowCreate = true;
  await dialog
    .getByRole("button", { name: "确定", exact: true })
    .press("Enter");
  await dialog.waitFor({ state: "hidden" });
  const list = await app.store.list();
  const created = list.find(
    (record) => record.name === "Local create visual fixture",
  );
  assert(created);
  const stored = await app.store.get(created.id);
  assert.equal(stored.description, description);
  assert.equal(list.length, 2);
  assert.deepEqual(writes, [
    { name: "Local create visual fixture", directory, description },
  ]);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  console.log(
    "PROJECT_CREATE_FORM_UI_PASS desktop+narrow/keyboard/chooser/stale-cancel/explicit-description/no-dispatch",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
