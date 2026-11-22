import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const root = await mkdtemp(join(tmpdir(), "workbench-db-connection-card-"));
const evidence = process.env.DB_CONNECTION_CARD_EVIDENCE;
let app, browser;
try {
  app = await createApp({ root, port: 0 });
  const owner = await app.store.create("默认项目");
  const before = await app.store.get(owner.id);
  const origin = new URL(app.launchUrl).origin;
  const observed = [],
    blocked = [],
    errors = [];
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
    locale: "zh-CN",
  });
  page.setDefaultTimeout(8500);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("theme", "light"));
  await page.route("**/*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin && request.method() === "GET") {
      observed.push(url.pathname);
      return route.continue();
    }
    blocked.push([request.method(), url.pathname]);
    return route.abort();
  });

  const manager = page.locator(".database-manager");
  const config = page.getByRole("region", { name: "数据库连接", exact: true });
  const query = page.getByRole("region", { name: "数据库查询", exact: true });
  const get = (id) => page.locator("#db-" + id);
  const type = get("type");
  const capture = async (file, narrow = false) => {
    if (!evidence) return;
    await mkdir(evidence, { recursive: true });
    await page.screenshot({
      path: join(evidence, file + ".png"),
      ...(narrow ? {} : { clip: { x: 0, y: 0, width: 1363, height: 980 } }),
      caret: "hide",
      animations: "disabled",
    });
  };
  const bounds = async (mode) => {
    const metrics = Object.fromEntries(
      await Promise.all(
        [
          ["config", config],
          ["parameters", config.getByRole("region", { name: "连接配置" })],
          ["engine", type],
          ["host", get("host")],
          ["port", get("port")],
          ["path", get("path")],
          ["query", query],
          ["readOnly", get("query")],
          ["authorize", get("register")],
        ].map(async ([key, locator]) => [key, await locator.boundingBox()]),
      ),
    );
    console.log("DB_CONNECTION_CARD_BOXES", mode, JSON.stringify(metrics));
    return metrics;
  };

  await page.goto(app.launchUrl);
  await page.locator('.rail [data-page="dictionary"]').click();
  await page
    .locator('.dictionary-side-nav [data-page="database-manager"]')
    .press("Enter");
  await manager.locator(".database-manager-empty").waitFor();
  await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url() === origin + "/api/database-capabilities" &&
        r.request().method() === "GET" &&
        r.status() === 200,
    ),
    manager.locator("#db-manager-configure").press("Enter"),
  ]);
  await config.waitFor();
  assert.equal(await type.inputValue(), "sqlite");
  assert.equal(await get("path").inputValue(), "");
  assert(await get("host").isHidden());
  assert(await get("tls").isHidden());
  assert(await get("write").isVisible());
  assert.equal(await get("write").isChecked(), false);
  assert.equal(
    await get("sql").inputValue(),
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  );

  await type.selectOption("mysql");
  const desktop = await bounds("mysql");
  await capture("database-connection-mysql");
  assert.equal(desktop.config.width, 600);
  assert.equal(desktop.engine.height, 32);
  assert.equal(desktop.host.height, 32);
  assert.equal(desktop.port.height, 32);
  assert(desktop.query.y >= desktop.config.y + desktop.config.height);
  assert.equal(await get("port").evaluate((node) => node.type), "text");
  assert.equal(await get("port").getAttribute("placeholder"), "3306");
  assert.equal(await get("port").inputValue(), "");
  assert.equal(await get("password").inputValue(), "");
  assert.equal(await get("password").getAttribute("type"), "password");
  assert.equal(await get("user").inputValue(), "");
  assert.equal(await get("name").inputValue(), "");
  assert(await get("tls").isVisible());
  assert(await get("ca").isHidden());
  await get("tls").check();
  assert(
    await config
      .getByText("自定义CA（PEM，可选）", { exact: true })
      .isVisible(),
  );
  assert.equal(await get("ca").inputValue(), "");
  await get("tls").uncheck();
  assert(await get("ca").isHidden());
  assert(await get("path").isHidden());
  assert(await get("write").isHidden());
  assert.equal(await get("sql").inputValue(), "SELECT 1 AS answer");
  assert.equal(
    await config
      .getByRole("button", {
        name: /测试连接|执行只读查询|授权为本项目会话连接/,
      })
      .count(),
    0,
  );
  assert(await query.getByRole("button", { name: "执行只读查询" }).isVisible());
  assert(
    await query
      .getByRole("button", { name: "授权为本项目会话连接" })
      .isVisible(),
  );

  await page.setViewportSize({ width: 430, height: 840 });
  const narrow = await bounds("mysql-430");
  await capture("database-connection-mysql-narrow", true);
  assert(narrow.config.x >= 0 && narrow.config.x + narrow.config.width <= 430);
  assert(
    narrow.port.x >= narrow.config.x &&
      narrow.port.x + narrow.port.width <= 430,
  );
  assert.equal(
    await config.evaluate((node) => node.scrollWidth - node.clientWidth),
    0,
  );
  assert(
    await get("port").evaluate(
      (input) =>
        input.previousElementSibling.getBoundingClientRect().bottom <=
        input.getBoundingClientRect().top,
    ),
  );
  await type.selectOption("sqlite");
  const sqlite = await bounds("sqlite-430");
  await capture("database-connection-sqlite-narrow", true);
  assert(sqlite.path.x + sqlite.path.width <= 430);
  assert(await config.getByLabel("SQLite 文件路径").isVisible());
  assert.equal(await get("path").inputValue(), "");
  assert(await get("password").isHidden());
  assert(await get("write").isVisible());
  assert.equal(await get("write").isChecked(), false);
  assert.deepEqual(
    await page
      .locator('.database-connection-page .form-grid [id^="db-"]')
      .evaluateAll((nodes) =>
        nodes
          .filter((node) => node.previousElementSibling?.htmlFor !== node.id)
          .map((node) => node.id),
      ),
    [],
  );

  await config
    .getByRole("button", { name: "数据库管理", exact: true })
    .press("Enter");
  await manager.locator(".database-manager-empty").waitFor();
  assert(observed.includes("/api/database-capabilities"));
  assert.deepEqual(await app.store.get(owner.id), before);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  if (evidence)
    await writeFile(
      join(evidence, "database-connection-card-metrics.json"),
      JSON.stringify({ desktop, narrow, sqlite }, null, 2) + "\n",
    );
  console.log(
    "DATABASE_CONNECTION_CARD_UI_PASS MySQL/SQLite metadata controls only; no query or write",
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
