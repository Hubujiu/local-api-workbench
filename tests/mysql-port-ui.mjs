import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { exerciseMySQLPortUI } from "./helpers/mysql-port-ui.mjs";
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({
    chromium,
  } = require("/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"));
}
const root = await mkdtemp(path.join(tmpdir(), "mysql-port-ui-"));
const app = await createApp({ root, port: 0 });
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_BUNDLED
      ? undefined
      : process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.launchUrl);
  await page.getByRole("button", { name: "发 送", exact: true }).waitFor();
  await page.locator('.rail [data-page="settings"]').click();
  await page.locator('[data-page="database"]').click();
  await exerciseMySQLPortUI(page);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: "/tmp/local-api-mysql-port-ui.png" });
  console.log("MYSQL_RAW_PORT_UI_PASS");
} finally {
  await browser?.close();
  app.server.closeAllConnections();
  await new Promise((resolve) => app.server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
