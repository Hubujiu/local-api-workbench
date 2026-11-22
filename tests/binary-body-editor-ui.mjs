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
const temporary = await mkdtemp(join(tmpdir(), "workbench-binary-editor-"));
const app = await createApp({ root: temporary, port: 0 });
const manualInitial = "TWFudWFsLXBsYWlu";
const fixture = (id, attributes) =>
  normalizeRequest({ id, name: id, method: "POST", url: "", ...attributes });
const origin = new URL(app.launchUrl).origin;
const forbidden = [],
  errors = [];
let browser;
try {
  let project = await app.store.create("Binary editor synthetic");
  project.requests = [
    fixture("Verification", { bodyType: "binary", body: "" }),
    fixture("Imported", { bodyType: "binary", body: manualInitial }),
    fixture("Metadata", {
      bodyType: "raw",
      body: "document only",
      postmanRawBody: { version: 1, language: "text" },
    }),
  ];
  project = await app.store.save(project);
  const before = structuredClone(await app.store.get(project.id));
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.on("pageerror", () => errors.push("unexpected script error"));
  await page.addInitScript((id) => {
    sessionStorage.setItem("project", id);
    localStorage.setItem("response-layout", "stacked");
    const arrayBuffer = File.prototype.arrayBuffer;
    const pending = new Map();
    window.hasHeldBinary = (name) => pending.has(name);
    window.resolveHeldBinary = async (name) => {
      const finish = pending.get(name);
      pending.delete(name);
      await finish();
      await Promise.resolve();
    };
    File.prototype.arrayBuffer = function () {
      if (this.name.startsWith("fail"))
        return Promise.reject(Error("untrusted filename/path detail"));
      if (!this.name.startsWith("held")) return arrayBuffer.call(this);
      return new Promise((resolve, reject) =>
        pending.set(this.name, async () => {
          if (this.name.includes("error")) reject(Error("untrusted detail"));
          else resolve(await arrayBuffer.call(this));
        }),
      );
    };
  }, project.id);
  await page.route("**/*", (route) => {
    const request = route.request();
    if (new URL(request.url()).origin === origin && request.method() === "GET")
      return route.continue();
    forbidden.push(request.method());
    return route.abort();
  });
  await page.goto(app.launchUrl);
  const editor = page.locator(".editor");
  const input = page.getByLabel("上传文件", { exact: true });
  const box = page.locator(".binary-body-upload");
  const upload = () => page.waitForEvent("filechooser");
  const choose = (name, bytes = Buffer.from([0, 255, 48, 22, 128])) =>
    input.setInputFiles({
      name,
      mimeType: "application/octet-stream",
      buffer: bytes,
    });
  const reveal = page.getByRole("button", {
    name: "手动编辑 Base64",
    exact: true,
  });
  const manual = page.getByRole("textbox", {
    name: "请求体 Base64",
    exact: true,
  });
  const closeManual = page.getByRole("button", {
    name: "收起 Base64",
    exact: true,
  });
  const note = page.locator("#binary-body-note");
  const raw = page.locator("#body-code");
  const bodyTab = page.locator('[data-param="body"]');
  const radio = (type) =>
    page.locator(`input[name="body-type"][value="${type}"]`);
  const select = (id) => page.locator(`[data-request="${id}"]`).click();
  const active = (locator) =>
    locator.evaluate((node) => node === document.activeElement);
  const assertMode = async (type) =>
    assert.equal(await radio(type).isChecked(), true);
  const whenConfirm = async (message, accept, perform) => {
    const outcome = page
      .waitForEvent("dialog", { timeout: 5000 })
      .then(async (dialog) => {
        assert.equal(dialog.type(), "confirm");
        const actual = dialog.message();
        if (accept) await dialog.accept();
        else await dialog.dismiss();
        assert.match(actual, message);
      });
    await Promise.all([outcome, perform()]);
  };
  const hold = async (name) => {
    await choose(name);
    await page.waitForFunction((target) => window.hasHeldBinary(target), name);
  };
  const release = (name) =>
    page.evaluate((target) => window.resolveHeldBinary(target), name);
  const discard = (type, accept) =>
    whenConfirm(/切换二进制正文格式会清除当前正文/, accept, () =>
      radio(type).press("Space"),
    );
  const evidence = process.env.BINARY_BODY_EVIDENCE;
  const capture = async (name, narrow = false) => {
    if (!evidence) return;
    await mkdir(evidence, { recursive: true });
    await page.screenshot({
      path: join(evidence, name + ".png"),
      caret: "hide",
      animations: "disabled",
      ...(narrow ? {} : { clip: { x: 355, y: 184, width: 1008, height: 206 } }),
    });
  };

  await bodyTab.press("Enter");
  await input.waitFor();
  assert.equal(await manual.count(), 0);
  assert.equal(await raw.count(), 0);
  assert.equal(
    await editor
      .locator("#generate-body,#format-json,#toggle-parameter-helper")
      .count(),
    0,
  );
  const emptyBox = await box.boundingBox();
  console.log("BINARY_EMPTY_BOX", JSON.stringify(emptyBox));
  await capture("binary-workbench-empty");
  assert.deepEqual(
    [emptyBox.x, emptyBox.y, emptyBox.width, emptyBox.height].map(Math.round),
    [383, 285, 952, 66],
  );
  const [chooser] = await Promise.all([upload(), input.press("Enter")]);
  assert.equal(chooser.isMultiple(), false);
  await chooser.setFiles([]);
  assert.equal(await input.evaluate((control) => control.files.length), 0);
  assert.equal(await note.innerText(), "");
  assert.match(await page.locator("#saved-state").innerText(), /已保存/);

  await hold("held-route-error.bin");
  await page.locator('.rail [data-page="history"]').click();
  await page.locator('.rail [data-page="apis"]').click();
  await input.waitFor();
  await release("held-route-error.bin");
  assert.equal(await note.innerText(), "");
  assert.doesNotMatch(await page.locator("#toast").innerText(), /无法读取/);

  await hold("held-request.bin");
  await select("Imported");
  assert.equal(await note.innerText(), "已载入二进制请求体");
  assert.equal(await manual.count(), 0);
  assert.doesNotMatch(await editor.innerHTML(), new RegExp(manualInitial));
  await reveal.press("Enter");
  assert.equal(await active(manual), true);
  assert.equal(await manual.inputValue(), manualInitial);
  await closeManual.press("Enter");
  await whenConfirm(/替换文件会清除/, false, () => choose("cancelled.bin"));
  await reveal.click();
  assert.equal(await manual.inputValue(), manualInitial);
  await closeManual.press("Enter");
  await select("Verification");
  await release("held-request.bin");
  assert.equal(await note.innerText(), "");

  await hold("held-format.bin");
  await radio("msgpack").press("Space");
  await assertMode("msgpack");
  assert.equal(await raw.inputValue(), "");
  await radio("binary").press("Space");
  await assertMode("binary");
  await release("held-format.bin");
  assert.equal(await note.innerText(), "");

  await hold("held-old.bin");
  await hold("held-new.bin");
  await release("held-old.bin");
  assert.equal(await note.innerText(), "");
  await release("held-new.bin");
  await page.getByText("已载入二进制请求体", { exact: true }).waitFor();
  const selected = Buffer.from([0, 255, 48, 22, 128]).toString("base64");
  assert.doesNotMatch(await editor.innerHTML(), /held-new\.bin/);
  await reveal.click();
  assert.equal(await manual.inputValue(), selected);

  await whenConfirm(/替换文件会清除/, true, () =>
    choose("held-manual.bin", Buffer.from([11, 22, 33])),
  );
  await page.waitForFunction(() => window.hasHeldBinary("held-manual.bin"));
  await manual.fill("eHl6");
  await manual.fill(selected);
  await release("held-manual.bin");
  assert.equal(await manual.inputValue(), selected);
  await whenConfirm(/替换文件会清除/, true, () => choose("fail-fixture.bin"));
  await page
    .getByText("无法读取选择的文件，请重新选择", { exact: true })
    .waitFor();
  assert.doesNotMatch(await page.locator("#toast").innerText(), /untrusted/);
  assert.equal(await manual.inputValue(), selected);
  await whenConfirm(/替换文件会清除/, true, () =>
    choose("empty.bin", Buffer.alloc(0)),
  );
  await page.getByText("请选择非空文件", { exact: true }).waitFor();
  assert.equal(await manual.inputValue(), selected);

  await discard("raw", false);
  await assertMode("binary");
  assert.equal(await active(radio("binary")), true);
  assert.equal(await manual.inputValue(), selected);
  await page.locator('[data-mode="design"]').press("Enter");
  await page.locator('[data-design-parameter="body"]').press("Enter");
  assert.equal(await input.count(), 0);
  assert.equal(await page.locator("#generate-body").count(), 0);
  assert.equal(await manual.count(), 0);
  await reveal.press("Enter");
  assert.equal(await manual.inputValue(), selected);
  await discard("raw", true);
  await assertMode("raw");
  assert.equal(await raw.inputValue(), "");
  await raw.fill('{"typed": true}');
  await discard("binary", false);
  assert.equal(await raw.inputValue(), '{"typed": true}');
  await discard("binary", true);
  await reveal.press("Enter");
  assert.equal(await manual.inputValue(), "");
  await page.locator('[data-mode="debug"]').press("Enter");
  await reveal.press("Enter");
  await manual.fill("eHl6");
  await discard("msgpack", true);
  await assertMode("msgpack");
  assert.equal(await raw.inputValue(), "");

  await select("Metadata");
  await radio("binary").press("Space");
  await page.getByText(/此正文含有导入或动态模板/).waitFor();
  await assertMode("raw");
  assert.equal(await raw.inputValue(), "document only");
  await select("Verification");
  await radio("binary").press("Space");
  await assertMode("binary");
  await page.setViewportSize({ width: 430, height: 830 });
  await input.focus();
  assert.equal(await active(input), true);
  assert.ok((await box.boundingBox()).width < 430);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  await capture("binary-workbench-narrow", true);
  assert.deepEqual(await app.store.get(project.id), before);
  assert.deepEqual(forbidden, [], "no dispatch or automatic project writes");
  assert.deepEqual(errors, []);
  console.log(
    "BINARY_BODY_UI_PASS no writes/dispatch; owned capture, focus, cancel and async guards",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(temporary, { recursive: true, force: true });
}
