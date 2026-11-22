import { chooseProjectSwitch } from "./helpers/project-switch-confirmation-ui.mjs";
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
const evidence = process.env.API_WELCOME_EVIDENCE;
const root = await mkdtemp(join(tmpdir(), "workbench-api-welcome-"));
const app = await createApp({ root, port: 0 });
let browser;
try {
  const source = await app.store.create("Switch Visual Fixture A");
  source.requests = [
    normalizeRequest({
      id: "fixture",
      name: "Verification",
      method: "GET",
      url: "http://127.0.0.1:38982/no-send",
    }),
  ];
  await app.store.save(source);
  const destination = await app.store.create("Switch Visual Fixture B");
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
  });
  const origin = new URL(app.launchUrl).origin;
  const blocked = [],
    errors = [],
    reads = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((owner) => {
    sessionStorage.setItem("project", owner);
    localStorage.setItem("theme", "light");
  }, source.id);
  await page.route("**/*", (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (
      new URL(request.url()).origin === origin &&
      request.method() === "GET" &&
      !url.pathname.includes("mcp-database-connections") &&
      url.pathname !== "/mcp"
    ) {
      if (url.pathname.startsWith("/api/")) reads.push(url.pathname);
      return route.continue();
    }
    blocked.push(request.method());
    return route.abort();
  });
  await page.goto(app.launchUrl);
  const projectSelect = page.locator("#project-select");
  const adopted = (id) =>
    page.waitForFunction(
      (value) =>
        document.querySelector("#project-select option[selected]")?.value ===
        value,
      id,
    );
  await adopted(source.id);
  await page.locator("#request-name").waitFor();
  const to = async (id, decision) => {
    const open = () => projectSelect.selectOption(id);
    if (typeof decision === "boolean")
      await chooseProjectSwitch(page, decision ? "discard" : "cancel", open);
    else await open();
    if (decision !== false) await adopted(id);
  };
  await to(destination.id);
  const welcome = page.getByRole("region", { name: "在本机管理和调试 API" });
  const card = welcome.getByRole("region", { name: "四步连接本机 MCP" });
  const importer = welcome.getByRole("button", {
    name: "导入项目",
    exact: true,
  });
  const creator = welcome.getByRole("button", {
    name: "新建 HTTP 接口",
    exact: true,
  });
  const mcp = welcome.getByRole("button", {
    name: "打开 MCP 设置",
    exact: true,
  });
  const bounds = (locator) =>
    locator
      .boundingBox()
      .then(({ x, y, width, height }) => [x, y, width, height].map(Math.round));
  const capture = async (label, narrow = false) => {
    if (!evidence) return;
    await mkdir(evidence, { recursive: true });
    await page.mouse.move(1090, 85);
    await page.screenshot({
      path: join(evidence, "api-welcome-" + label + ".png"),
      ...(narrow ? {} : { clip: { x: 0, y: 0, width: 1363, height: 880 } }),
      caret: "hide",
    });
  };
  const request = page.locator("#request-name");
  await welcome.waitFor();
  assert.equal(await request.count(), 0);
  assert.equal(await card.getByRole("listitem").count(), 4);
  assert.equal(await page.locator(".tab-scroll .tab-switch").count(), 0);
  const desktop = {
    brand: await bounds(welcome.locator(".api-welcome-brand")),
    card: await bounds(card),
    mcp: await bounds(mcp),
    actions: await bounds(welcome.locator(".api-welcome-actions")),
  };
  console.log("API_WELCOME_GEOMETRY", JSON.stringify(desktop));
  await capture("desktop");
  assert(Math.abs(desktop.brand[0] - 549) <= 2);
  assert(Math.abs(desktop.brand[1] - 219) <= 2);
  assert.equal(desktop.card[2], 620);
  assert(Math.abs(desktop.card[1] - 329) <= 4);
  assert(Math.abs(desktop.card[1] + desktop.card[3] - 793) <= 6);
  assert(Math.abs(desktop.mcp[1] - 732) <= 6);
  assert.deepEqual(
    reads.filter((uri) => uri === "/api/projects/" + destination.id),
    ["/api/projects/" + destination.id],
  );
  const focused = (locator) =>
    locator.evaluate((node) => node === document.activeElement);
  const openAndCloseImport = async (keyboard) => {
    if (keyboard) await importer.press("Enter");
    else await importer.click();
    const dialog = page.getByRole("dialog", { name: "导入项目（手动）" });
    await dialog.locator(".local-project-import").waitFor();
    assert.equal(await dialog.locator("#import-file").count(), 1);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert(await focused(importer));
    assert.equal(await request.count(), 0);
  };
  await openAndCloseImport(true);
  await mcp.press("Enter");
  const settings = page.getByRole("heading", { name: "MCP 连接", exact: true });
  await settings.waitFor();
  assert(await focused(settings));
  await page
    .locator("#settings-mcp .mcp-service-card")
    .getByText("已关闭", { exact: true })
    .waitFor();
  await page.locator('.rail [data-page="apis"]').press("Enter");
  await welcome.waitFor();
  await page.setViewportSize({ width: 430, height: 760 });
  await capture("narrow", true);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  assert.equal(
    await welcome.evaluate((node) => node.scrollWidth - node.clientWidth),
    0,
  );
  await openAndCloseImport(false);
  await creator.click();
  await request.waitFor();
  assert(await focused(request));
  assert.equal(await page.locator(".tab-scroll .tab-switch").count(), 1);
  assert.equal(await page.locator("#saved-state").textContent(), "● 未保存");
  const stored = await app.store.get(destination.id);
  assert.equal(stored.requests.length, 0);
  assert.equal(stored.configRevision, destination.configRevision);
  await page.setViewportSize({ width: 1363, height: 1023 });
  await to(source.id, true);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  assert.equal((await app.store.get(destination.id)).requests.length, 0);
  console.log(
    "API_WELCOME_UI_PASS after-real-switch/620px/1363+430/import-cancel/off-MCP/draft-only/no-writes",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
