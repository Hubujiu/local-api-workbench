import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { exerciseSocketIOUI } from "./helpers/socketio-ui.mjs";
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({
    chromium,
  } = require("/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"));
}
const root = await mkdtemp(path.join(os.tmpdir(), "socketio-ack-ui-"));
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
  const page = await browser.newPage({
    viewport: { width: 1440, height: 950 },
  });
  await page.goto(app.launchUrl);
  await page.locator("#new-project").waitFor();
  await exerciseSocketIOUI(page);
} finally {
  await browser?.close();
  await app.close();
}
