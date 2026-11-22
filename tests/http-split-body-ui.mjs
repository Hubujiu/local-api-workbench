import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRequest } from "../src/core.mjs";
import { createApp } from "../src/server.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const home = await mkdtemp(join(tmpdir(), "workbench-split-body-"));
const app = await createApp({ root: home, port: 0 });
const origin = new URL(app.launchUrl).origin;
const blocked = [],
  errors = [];
const literal = ' {"message":"fixture","wide":9007199254740993} ';
let browser;
try {
  let owner = await app.store.create("布局验证");
  const fixture = (id, attributes) =>
    normalizeRequest({
      id,
      name: id === "empty" ? "Verification" : id,
      method: "GET",
      url: "",
      ...attributes,
    });
  owner.requests = [
    fixture("empty", { bodyType: "none" }),
    fixture("json", {
      bodyType: "json",
      body: literal,
      headers: [{ key: "X-Fixture", value: "preserve", enabled: true }],
    }),
    fixture("upload", { bodyType: "binary" }),
    fixture("form", {
      bodyType: "form-data",
      form: [
        {
          key: "file",
          type: "file",
          value: "",
          enabled: true,
          requiresFile: true,
        },
      ],
    }),
    fixture("imported", {
      bodyType: "raw",
      body: "protected source",
      postmanRawBody: { version: 1, language: "text" },
    }),
    fixture("unknown", {
      bodyType: "fixture-future-format",
      body: "opaque payload",
    }),
  ];
  owner = await app.store.save(owner);
  const baseline = await app.store.get(owner.id);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
  });
  await page.addInitScript((id) => {
    sessionStorage.setItem("project", id);
    const originalBuffer = File.prototype.arrayBuffer;
    let finish;
    File.prototype.arrayBuffer = function () {
      if (this.name !== "local-fixture.bin") return originalBuffer.call(this);
      return new Promise((resolve) => {
        window.heldFixtureReady = true;
        finish = () => originalBuffer.call(this).then(resolve);
      });
    };
    window.finishFixture = () => finish();
  }, owner.id);
  await page.route("**/*", (route) => {
    const req = route.request();
    if (new URL(req.url()).origin === origin && req.method() === "GET")
      return route.continue();
    blocked.push(req.method());
    return route.abort();
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.launchUrl);
  const editor = page.locator("[data-http-response-layout]");
  const compact = editor.getByRole("combobox", {
    name: "请求正文类型",
    exact: true,
  });
  const rawFormat = editor.getByRole("combobox", {
    name: "Raw格式",
    exact: true,
  });
  const radios = editor.locator('input[name="body-type"]');
  const checked = editor.locator('input[name="body-type"]:checked');
  const footer = page.locator("#response-layout");
  const toast = page.locator("#toast");
  const raw = editor.getByRole("textbox", { name: "请求体", exact: true });
  const selectRequest = async (id) => {
    await page.locator(`[data-request="${id}"]`).click();
    await page.locator('[data-mode="debug"]').press("Enter");
    await editor.locator('[data-param="body"]').press("Enter");
  };
  const mode = async (family) => {
    assert.equal(await compact.inputValue(), family);
    assert.equal(await checked.inputValue(), family);
  };
  const current = (field) =>
    field.evaluate((node) => node === document.activeElement);
  const capture = async (label) => {
    const target = process.env.HTTP_SPLIT_BODY_EVIDENCE;
    if (!target) return;
    await mkdir(target, { recursive: true });
    await page.screenshot({
      path: join(target, "http-split-body-" + label + ".png"),
      caret: "hide",
      animations: "disabled",
    });
  };
  const flip = () => footer.press("Enter");
  await selectRequest("empty");
  assert.equal(await compact.isVisible(), false);
  assert.equal(await radios.first().isVisible(), true);
  await flip();
  await mode("none");
  assert.equal(await radios.first().isVisible(), false);
  const bounds = await compact.boundingBox();
  console.log("HTTP_SPLIT_BODY_NONE", JSON.stringify(bounds));
  await capture("none-desktop");
  assert(
    Math.abs(bounds.x - 375) <= 3 &&
      Math.abs(bounds.y + bounds.height / 2 - 249) <= 10,
  );
  assert.equal(bounds.width, 60);
  assert.equal(await compact.locator("option").count(), 6);
  // Exercise the native select keyboard pattern on two safe, nonbinary modes.
  await compact.press("ArrowDown");
  await mode("form-data");
  assert.equal(await current(compact), true);
  await compact.press("Home");
  await mode("none");

  await selectRequest("json");
  await mode("raw");
  assert.equal(await rawFormat.inputValue(), "json");
  assert.equal(await rawFormat.count(), 1);
  assert.equal(await raw.inputValue(), literal);
  await rawFormat.selectOption("raw");
  await mode("raw");
  assert.equal(await rawFormat.inputValue(), "raw");
  await raw.focus();
  await raw.evaluate((node) => node.setSelectionRange(4, 9));
  const rawIdentity = await raw.elementHandle();
  await flip();
  assert.equal(await compact.isVisible(), false);
  await flip();
  assert.equal(await rawIdentity.evaluate((node) => node.isConnected), true);
  assert.equal(await raw.inputValue(), literal);
  assert.deepEqual(
    await raw.evaluate((node) => [node.selectionStart, node.selectionEnd]),
    [4, 9],
  );
  assert.equal(await rawFormat.inputValue(), "raw");
  await capture("raw-desktop");
  await editor.locator('[data-param="headers"]').press("Enter");
  assert.equal(
    await editor.locator('input[data-pair="headers:0:value"]').inputValue(),
    "preserve",
  );

  await selectRequest("upload");
  const picker = editor.getByLabel("上传文件", { exact: true });
  const pickerIdentity = await picker.elementHandle();
  await picker.setInputFiles({
    name: "local-fixture.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from([0, 1, 2]),
  });
  await page.waitForFunction(() => window.heldFixtureReady);
  await flip();
  await flip();
  assert.equal(await pickerIdentity.evaluate((node) => node.isConnected), true);
  await page.evaluate(() => window.finishFixture());
  await editor.getByText("已载入二进制请求体", { exact: true }).waitFor();
  await editor
    .getByRole("button", { name: "手动编辑 Base64", exact: true })
    .press("Enter");
  const base64 = editor.getByRole("textbox", {
    name: "请求体 Base64",
    exact: true,
  });
  assert.equal(await base64.inputValue(), "AAEC");
  const dialog = async (accept) => {
    const handled = page.waitForEvent("dialog").then(async (prompt) => {
      assert.match(prompt.message(), /清除当前正文/);
      await (accept ? prompt.accept() : prompt.dismiss());
    });
    await Promise.all([handled, compact.selectOption("raw")]);
  };
  await dialog(false);
  await mode("binary");
  assert.equal(await current(compact), true);
  assert.equal(await base64.inputValue(), "AAEC");
  await dialog(true);
  await mode("raw");
  assert.equal(await rawFormat.inputValue(), "json");
  assert.equal(await raw.inputValue(), "");

  await selectRequest("form");
  await compact.selectOption("urlencoded");
  assert.match(await toast.textContent(), /URLencoded 不支持文件/);
  await mode("form-data");
  assert.equal(await current(compact), true);
  await selectRequest("imported");
  await compact.selectOption("binary");
  assert.match(await toast.textContent(), /此正文含有导入或动态模板/);
  await mode("raw");
  assert.equal(await raw.inputValue(), "protected source");

  await selectRequest("unknown");
  assert.equal(await compact.isDisabled(), true);
  assert.equal(await checked.count(), 0);
  assert.equal(await raw.inputValue(), "opaque payload");
  await flip();
  await flip();
  assert.equal(await raw.inputValue(), "opaque payload");
  assert.equal(await checked.count(), 0);

  await selectRequest("empty");
  await compact.focus();
  await page.setViewportSize({ width: 430, height: 830 });
  await radios.first().waitFor();
  assert.equal(await compact.isVisible(), false);
  assert.equal(await current(radios.first()), true);
  assert.equal(
    await page.evaluate(() => localStorage.getItem("response-layout")),
    "split",
  );
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  await capture("stacked-narrow");
  await page.setViewportSize({ width: 1363, height: 1023 });
  await compact.waitFor();
  assert.equal(await current(compact), true);
  await mode("none");
  assert.deepEqual(await app.store.get(owner.id), baseline);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  console.log(
    "HTTP_SPLIT_BODY_UI_PASS guards, retained drafts and chooser, no execute or project writes",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(home, { recursive: true, force: true });
}
