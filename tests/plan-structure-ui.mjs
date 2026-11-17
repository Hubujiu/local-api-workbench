import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { exercisePlanStructureEditor } from "./helpers/plan-structure-ui.mjs";
const root = await mkdtemp(path.join(os.tmpdir(), "plan-structure-ui-"));
const app = await createApp({ root, port: 0 });
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_BUNDLED
    ? undefined
    : process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(app.launchUrl);
  await page.locator("#new-project").waitFor();
  await exercisePlanStructureEditor(page);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await new Promise((r) => app.server.close(r));
  await rm(root, { recursive: true, force: true });
}
