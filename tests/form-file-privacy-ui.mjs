import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const root = await mkdtemp(join(tmpdir(), "workbench-form-privacy-"));
const app = await createApp({ root, port: 0 });
let browser;
try {
  let owner = await app.store.create("Multipart privacy fixture");
  const secret = Buffer.from("only internal synthetic bytes").toString(
    "base64",
  );
  owner.requests = [
    normalizeRequest({
      id: "privacy",
      name: "Multipart fixture",
      method: "POST",
      url: "http://127.0.0.1:38982/no-send",
      bodyType: "form-data",
      form: [
        {
          key: "source",
          type: "file",
          value: secret,
          filename: "selected.bin",
        },
        {
          key: "locked",
          type: "file",
          value: "",
          requiresFile: true,
          filename: "imported.bin",
          contentType: "application/octet-stream",
          schema: { type: "string", format: "binary" },
          enabled: false,
        },
        { key: "plain", type: "text", value: "ordinary-example" },
      ],
    }),
    normalizeRequest({
      id: "legacy",
      name: "Legacy form",
      bodyType: "urlencoded",
      form: [
        {
          key: "legacy-file",
          type: "text",
          value: secret,
          filename: "legacy.bin",
        },
      ],
    }),
  ];
  owner = await app.store.save(owner);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
  });
  const origin = new URL(app.launchUrl).origin,
    blocked = [],
    errors = [];
  page.on("pageerror", () => errors.push("unexpected page error"));
  await page.addInitScript((id) => {
    sessionStorage.setItem("project", id);
    const original = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      if (this.name.startsWith("held-"))
        return new Promise((resolve) => {
          window.releaseHeldMultipartFile = async () =>
            resolve(await original.call(this));
        });
      return original.call(this);
    };
  }, owner.id);
  await page.route("**/*", (route) => {
    const req = route.request(),
      u = new URL(req.url());
    if (u.origin === origin && req.method() === "GET") return route.continue();
    blocked.push(req.method());
    return route.abort();
  });
  await page.goto(app.launchUrl);
  const bodyTab = page.locator('[data-param="body"]');
  const bodyMode = (mode) =>
    page.locator(`input[name="body-type"][value="${mode}"]`);
  const row = (i) => page.locator(`[data-multipart-row="${i}"]`);
  const file = (i) => row(i).locator("input[type=file]");
  const type = (i) => row(i).getByRole("combobox", { name: "字段类型" });
  const value = (i) =>
    row(i).getByRole("textbox", { name: "参数值", exact: true });
  const hostConfirm = async (i, next, accept) => {
    let observed;
    page.once("dialog", (dialog) => {
      observed = dialog.message();
      return accept ? dialog.accept() : dialog.dismiss();
    });
    await type(i).selectOption(next);
    assert.match(observed, /清除当前值或文件/);
  };
  await bodyTab.press("Enter");
  await row(0).getByText("selected.bin", { exact: true }).waitFor();
  await hostConfirm(0, "text", false);
  assert.equal(await type(0).inputValue(), "file");
  assert.equal(await value(0).count(), 0);
  await hostConfirm(0, "text", true);
  assert.equal(await value(0).inputValue(), "");
  await value(0).fill("typed text");
  await hostConfirm(0, "file", true);
  assert.equal(await file(0).evaluate((node) => node.files.length), 0);
  const hold = async (name) => {
    await file(0).setInputFiles({
      name,
      mimeType: "application/octet-stream",
      buffer: Buffer.from("held synthetic"),
    });
    await page.waitForFunction(
      () => typeof window.releaseHeldMultipartFile === "function",
    );
  };
  const release = () =>
    page.evaluate(async () => {
      const settle = window.releaseHeldMultipartFile;
      delete window.releaseHeldMultipartFile;
      await settle();
      await Promise.resolve();
    });
  await hold("held-type.bin");
  await type(0).selectOption("text");
  await type(0).selectOption("file");
  await release();
  assert.equal(
    await row(0).getByText("请选择文件", { exact: true }).count(),
    1,
  );
  await hold("held-body.bin");
  await bodyMode("none").check();
  await bodyMode("form-data").check();
  await release();
  assert.equal(
    await row(0).getByText("请选择文件", { exact: true }).count(),
    1,
  );
  await hold("held-tab.bin");
  await page.locator('[data-param="headers"]').press("Enter");
  await bodyTab.press("Enter");
  await release();
  assert.equal(
    await row(0).getByText("请选择文件", { exact: true }).count(),
    1,
  );

  await type(1).selectOption("text");
  await page
    .locator("#toast")
    .getByText(/保留原字段并新增/)
    .waitFor();
  assert.equal(await type(1).inputValue(), "file");
  await bodyMode("urlencoded").click();
  await page
    .locator("#toast")
    .getByText(/URLencoded 不支持文件/)
    .waitFor();
  assert(await bodyMode("form-data").isChecked());
  await file(0).setInputFiles({
    name: "fresh.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("fresh synthetic file"),
  });
  await row(0).getByText("fresh.bin", { exact: true }).waitFor();
  const annotate = async (i, description) => {
    await row(i).getByRole("button", { name: "定义", exact: true }).click();
    await page.locator("#parameter-description").fill(description);
    await page.locator("#dialog-save").press("Enter");
    await page.locator("#dialog").waitFor({ state: "hidden" });
  };
  await annotate(0, "file metadata only");
  await annotate(2, "text may be copied");
  await page.locator('.rail [data-page="dictionary"]').press("Enter");
  const captured = page.locator(".dictionary-temporary");
  const inspect = async (key, expected) => {
    await captured
      .locator(".row")
      .filter({ hasText: key })
      .getByRole("button")
      .click();
    const extras = JSON.parse(await page.locator("#modal-json").inputValue());
    assert.equal(extras.example, expected);
    await page.keyboard.press("Escape");
    await page.locator("#dialog").waitFor({ state: "hidden" });
  };
  await inspect("file metadata only", "");
  await inspect("text may be copied", "ordinary-example");
  await page.locator('.rail [data-page="apis"]').press("Enter");
  await page.locator('[data-request="legacy"]').press("Enter");
  await bodyTab.press("Enter");
  assert(await bodyMode("urlencoded").isChecked());
  assert.equal(await page.locator("[data-field-file]").count(), 0);
  assert.equal(await page.locator('[data-pair="form:0:value"]').count(), 0);
  assert(
    !(await page.locator(".request-panel").textContent()).includes(secret),
  );
  assert.deepEqual(await app.store.get(owner.id), owner);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  console.log(
    "FORM_FILE_PRIVACY_UI_PASS deselection/ABA-body-tab-type/metadata/URLencoded/no-copy/no-writes/no-transport",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
