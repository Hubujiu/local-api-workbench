import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const root = await mkdtemp(join(tmpdir(), "scoped-export-surface-"));
let app, browser;
try {
  app = await createApp({ root, port: 0 });
  const project = await app.store.create("导出范围合成验证");
  for (const [id, name, folder] of [
    ["verify", "Verification", ""],
    ["nested-request", "Synthetic request", "示例接口"],
  ]) {
    project.requests.push(
      normalizeRequest({ id, name, folder, url: "http://127.0.0.1:1/" + id }),
    );
  }
  project.documents.push({
    id: "synthetic-doc",
    title: "Synthetic note",
    content: "Disposable text",
  });
  project.dictionary.push({
    id: "synthetic-model",
    name: "Synthetic model",
    schema: { type: "string" },
  });
  await app.store.save(project);
  const before = await app.store.get(project.id);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
    locale: "zh-CN",
    colorScheme: "light",
  });
  page.setDefaultTimeout(7000);
  const origin = new URL(app.launchUrl).origin;
  const blocked = [],
    errors = [],
    downloads = [],
    metrics = {};
  await page.addInitScript(() => localStorage.setItem("theme", "light"));
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("download", (download) =>
    downloads.push(download.suggestedFilename()),
  );
  await page.route("**/*", (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === "GET" && url.origin === origin)
      return route.continue();
    blocked.push([req.method(), url.pathname]);
    return route.abort();
  });
  await page.goto(app.launchUrl);
  const dialog = page.locator("#dialog");
  const surface = dialog.locator(".scoped-export-surface");
  const format = surface.locator("#scoped-export-format");
  const checkbox = (kind) =>
    surface.locator(`input[data-kind="${kind}"]`).first();
  const tab = (id) => surface.locator(`#scoped-export-tab-${id}`);
  const controls = () =>
    surface.locator("[data-export-resource]:checked").count();
  const open = async () => {
    await page.locator("#export").click();
    await dialog.locator("#scoped-export-open").click();
    await surface.waitFor();
  };
  const close = async () => {
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
  };
  const prefix = process.env.SCOPED_EXPORT_CAPTURE_PREFIX;
  const capture = async (name) => {
    metrics[name] = await dialog.boundingBox();
    if (prefix)
      await page.screenshot({
        path: `${prefix}-${name}.png`,
        ...(name === "narrow"
          ? {}
          : { clip: { x: 0, y: 0, width: 1363, height: 980 } }),
        caret: "hide",
        animations: "disabled",
      });
  };
  await open();
  assert.equal(await format.inputValue(), "apipost");
  assert.equal(await surface.getByRole("radio").count(), 3);
  assert.equal(await surface.getByRole("tab").count(), 3);
  assert.equal(await controls(), 0);
  assert.equal(await tab("interface").innerText(), "接口和接口用例 (0/4)");
  assert.equal(await tab("model").innerText(), "数据模型 (0/1)");
  assert.equal(await tab("environment").innerText(), "环境 (0/1)");
  assert.equal(await checkbox("globals").isVisible(), true);
  assert.equal(await surface.getByText(/文件不是脱敏文件/).isVisible(), true);
  await capture("default");
  await checkbox("api").check();
  await tab("interface").press("ArrowRight");
  assert.equal(await tab("model").getAttribute("aria-selected"), "true");
  await checkbox("model").check();
  await tab("model").press("End");
  await checkbox("environment").check();
  assert.equal(await controls(), 3);
  assert.equal(await tab("interface").innerText(), "接口和接口用例 (1/4)");
  assert.equal(await tab("model").innerText(), "数据模型 (1/1)");
  assert.equal(await tab("environment").innerText(), "环境 (1/1)");
  await surface.getByRole("radio", { name: /Postman/ }).check();
  assert.equal(await format.inputValue(), "postman-collection-v2.1");
  assert.equal(await surface.getByText(/切换格式不自动清除/).isVisible(), true);
  assert.equal(await controls(), 3);
  await dialog.locator("#dialog-save").click();
  await page
    .getByText("Postman 集合仅支持选择接口或目录", { exact: true })
    .waitFor();
  assert.equal(await controls(), 3);
  await surface.getByRole("radio", { name: /目录 JSON/ }).check();
  assert.equal(await format.inputValue(), "apipost-directory");
  await capture("selected");
  await close();
  await open();
  assert.equal(await controls(), 0);
  assert.equal(await format.inputValue(), "apipost");
  await page.setViewportSize({ width: 430, height: 820 });
  assert.equal(
    await surface.evaluate((node) => node.scrollWidth <= node.clientWidth),
    true,
  );
  const mobile = await dialog.boundingBox();
  assert(mobile && mobile.x >= 0 && mobile.x + mobile.width <= 430);
  await tab("interface").press("End");
  assert.equal(await checkbox("environment").isVisible(), true);
  await checkbox("environment").press("Space");
  assert.equal(await tab("environment").innerText(), "环境 (1/1)");
  await capture("narrow");
  await close();
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(downloads, []);
  assert.deepEqual(await app.store.get(project.id), before);
  if (prefix)
    await writeFile(
      prefix + ".json",
      JSON.stringify({ metrics, blocked, errors, downloads }, null, 2) + "\n",
    );
  console.log(
    "SCOPED_EXPORT_SURFACE_UI_PASS real-formats/tabs/keyboard/narrow/unchecked/retained/zero-preview-or-write",
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
