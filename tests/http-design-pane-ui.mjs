import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || "playwright");
const root = await mkdtemp("/tmp/workbench-design-pane-");
const app = await createApp({ root, port: 0 });
let browser;
try {
  const project = await app.store.create("设计页验证");
  const request = normalizeRequest({
    name: "Verification",
    method: "GET",
    bodyType: "none",
    url: "http://127.0.0.1:38982/verification",
  });
  project.requests.push(request);
  await app.store.save(project);

  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
  });
  const origin = new URL(app.launchUrl).origin;
  const put = [];
  const forbidden = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin === origin && req.method() === "GET")
      return route.continue();
    if (
      url.origin === origin &&
      req.method() === "PUT" &&
      url.pathname === "/api/projects/" + project.id
    ) {
      put.push(req.method());
      return route.continue();
    }
    forbidden.push(req.method() + " " + url.pathname);
    return route.abort();
  });
  await page.goto(app.launchUrl);
  const design = page.locator('[data-mode="design"]');
  const debug = page.locator('[data-mode="debug"]');
  const descriptionSection = page.getByRole("region", {
    name: "详细说明",
    exact: true,
  });
  const disclosure = descriptionSection.locator(
    "#design-description > summary",
  );
  const description = page.getByRole("textbox", { name: "接口详细说明" });
  const draft = "**说明草稿**\n\n<script>window.unexpected = true;</script>";
  await design.click();
  assert.equal(await description.count(), 0, "empty details start closed");
  assert.equal(await page.locator("#send").count(), 0, "design is not Debug");
  const heading = descriptionSection.getByRole("heading", {
    name: "详细说明",
    exact: true,
  });
  await disclosure.waitFor({ state: "visible" });
  const headingBox = await heading.boundingBox();
  const disclosureBox = await disclosure.boundingBox();
  assert(
    headingBox &&
      disclosureBox &&
      disclosureBox.y >= headingBox.y + headingBox.height,
    "the disclosure must be visible below the Design details heading",
  );
  await disclosure.press("Enter");
  await description.fill(draft);
  assert.equal(
    await page.locator("#design-description-preview strong").innerText(),
    "说明草稿",
  );
  assert.equal(
    await page.locator("#design-description-preview script").count(),
    0,
  );

  await page.locator("#request-design-preview").click();
  const dialog = page.locator("#dialog");
  await dialog.getByText("说明草稿", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  assert.deepEqual(put, []);
  await debug.click();
  await design.click();
  assert.equal(await description.inputValue(), draft);

  await disclosure.press("Enter");
  assert.equal(await description.count(), 0);
  await page.setViewportSize({ width: 680, height: 760 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    680,
  );
  await disclosure.press("Enter");
  assert.equal(await description.inputValue(), draft);
  assert.equal(await page.locator("#visual-schema").count(), 1);
  assert.equal(await page.locator("#new-response-schema").count(), 1);
  await page.locator("#save").click();
  await page
    .locator("#saved-state")
    .getByText("✓ 已保存", { exact: true })
    .waitFor();
  assert.deepEqual(put, ["PUT"]);
  await page.reload();
  await design.click();
  assert.equal(await description.inputValue(), draft);
  assert.deepEqual(forbidden, []);
  assert.deepEqual(errors, []);
  console.log(
    "HTTP_DESIGN_PANE_PASS disclosure/preview/scope/explicit-save/reload",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
