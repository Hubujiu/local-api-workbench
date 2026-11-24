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
    await page.mouse.move(narrow ? 424 : 1090, 85);
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
  const geometry = async () => ({
    brand: await bounds(welcome.locator(".api-welcome-brand")),
    card: await bounds(card),
    mcp: await bounds(mcp),
    actions: await bounds(welcome.locator(".api-welcome-actions")),
  });
  const resetWelcomeScroll = async () => {
    const scroll = await welcome.evaluate(async (view) => {
      const workspace = view.closest(".workspace");
      const root = view.ownerDocument.scrollingElement;
      for (const node of [view, workspace, root]) {
        node.scrollTop = 0;
        node.scrollLeft = 0;
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return [
        view.scrollTop,
        workspace.scrollTop,
        root.scrollTop,
        root.scrollLeft,
      ];
    });
    assert.deepEqual(
      scroll,
      [0, 0, 0, 0],
      "compare and capture the welcome view at the top",
    );
  };
  const desktop = await geometry();
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
  const theme = page.locator("#theme");
  const isDark = () => page.locator("body.dark").count();
  const palette = () =>
    welcome.evaluate((view) => {
      const css = (selector) => getComputedStyle(view.querySelector(selector));
      const own = getComputedStyle(view);
      const doc = getComputedStyle(view.ownerDocument.body);
      const sidebar = getComputedStyle(
        view.ownerDocument.querySelector(".sidebar"),
      );
      const panel = css(".api-welcome-card");
      const primary = css("#welcome-mcp");
      const importButton = css("#welcome-import");
      const createButton = css("#welcome-add");
      return {
        canvas: own.backgroundColor,
        canvasFallback: doc.backgroundColor,
        sidebar: sidebar.backgroundColor,
        panel: panel.backgroundColor,
        panelBorder: panel.borderTopColor,
        copy: css(".api-welcome-card p").color,
        intro: css(".api-welcome-intro").color,
        primary: primary.backgroundColor,
        primaryText: primary.color,
        import: importButton.backgroundColor,
        importBorder: importButton.borderTopColor,
        create: createButton.backgroundColor,
        createBorder: createButton.borderTopColor,
      };
    });
  const contrast = (left, right) => {
    const linear = (x) =>
      x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    const lum = (rgb) =>
      [...rgb.matchAll(/\d+/g)]
        .slice(0, 3)
        .map(
          ([n], index) =>
            [0.2126, 0.7152, 0.0722][index] * linear(Number(n) / 255),
        )
        .reduce((a, b) => a + b, 0);
    const values = [lum(left), lum(right)].sort((a, b) => b - a);
    return (values[0] + 0.05) / (values[1] + 0.05);
  };
  const light = await palette();
  assert.deepEqual(
    [light.canvas, light.panel, light.primary],
    ["rgba(0, 0, 0, 0)", "rgb(249, 245, 234)", "rgb(138, 107, 60)"],
  );
  await theme.click();
  assert.equal(await isDark(), 1);
  const dark = await palette();
  console.log("API_WELCOME_DARK_PALETTE", JSON.stringify(dark));
  assert.deepEqual(dark, {
    canvas: "rgb(29, 26, 19)",
    canvasFallback: "rgb(30, 26, 18)",
    sidebar: "rgb(21, 18, 13)",
    panel: "rgb(23, 20, 15)",
    panelBorder: "rgb(44, 39, 33)",
    copy: "rgb(166, 155, 131)",
    intro: "rgb(166, 155, 131)",
    primary: "rgb(228, 202, 145)",
    primaryText: "rgb(32, 26, 16)",
    import: "rgb(29, 26, 19)",
    importBorder: "rgb(49, 44, 38)",
    create: "rgb(29, 26, 19)",
    createBorder: "rgb(49, 44, 38)",
  });
  assert(contrast(dark.copy, dark.panel) >= 4.5);
  assert(contrast(dark.intro, dark.canvas) >= 4.5);
  assert(contrast(dark.primaryText, dark.primary) >= 4.5);
  assert.deepEqual(await geometry(), desktop);
  await capture("desktop-dark");
  await mcp.press("Tab");
  assert(await focused(importer));
  await openAndCloseImport(true);
  await theme.click();
  assert.equal(await isDark(), 0);
  assert.deepEqual(await palette(), light);
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
  await resetWelcomeScroll();
  await capture("narrow", true);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  assert.equal(
    await welcome.evaluate((node) => node.scrollWidth - node.clientWidth),
    0,
  );
  const narrowLight = await geometry();
  await theme.click();
  assert.equal(await isDark(), 1);
  await resetWelcomeScroll();
  const narrowDark = await geometry();
  console.log(
    "API_WELCOME_NARROW_GEOMETRY",
    JSON.stringify({ light: narrowLight, dark: narrowDark }),
  );
  assert.deepEqual(narrowDark, narrowLight);
  assert.equal(
    await welcome.evaluate((node) => node.scrollWidth - node.clientWidth),
    0,
  );
  await capture("narrow-dark", true);
  await openAndCloseImport(true);
  await theme.click();
  assert.equal(await isDark(), 0);
  await resetWelcomeScroll();
  assert.deepEqual(await geometry(), narrowLight);
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
  await welcome.waitFor();
  assert.equal(await request.count(), 0);
  assert.equal(await page.locator('#tree [data-request="fixture"]').count(), 1);
  await theme.click();
  assert.equal(await isDark(), 1);
  assert.deepEqual(await palette(), dark);
  await resetWelcomeScroll();
  assert.deepEqual(await geometry(), desktop);
  await capture("desktop-dark-populated-tree");
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  assert.equal((await app.store.get(destination.id)).requests.length, 0);
  console.log(
    "API_WELCOME_UI_PASS after-real-switch/620px/1363+430/light-dark/contrast/geometry/import-cancel/off-MCP/draft-only/no-writes",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
