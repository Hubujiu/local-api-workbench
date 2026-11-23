import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportOpenAPI, normalizeRequest } from "../src/core.mjs";
import { createApp } from "../src/server.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const temp = await mkdtemp(join(tmpdir(), "workbench-design-path-"));
const endpoint = "http://127.0.0.1:38982/verification";
let app, browser;
try {
  app = await createApp({ root: temp, port: 0 });
  const owner = await app.store.create("Design Path fixture");
  const original = normalizeRequest({
    id: "path-primary",
    name: "Verification",
    url: endpoint,
  });
  const unrelatedPath = {
    key: "legacy",
    value: "0002",
    enabled: true,
    required: true,
    schema: { type: "string", minLength: 2 },
  };
  const unrelated = normalizeRequest({
    id: "path-secondary",
    name: "Independent",
    url: endpoint + "/other/{legacy}",
    path: [unrelatedPath],
  });
  owner.requests.push(original, unrelated);
  await app.store.save(owner);
  const baseline = await app.store.get(owner.id);
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
    locale: "zh-CN",
  });
  await page.addInitScript((id) => {
    localStorage.setItem("theme", "light");
    sessionStorage.setItem("project", id);
  }, owner.id);
  page.setDefaultTimeout(6000);
  const blocked = [],
    writes = [],
    errors = [];
  let allowSave = false;
  const origin = new URL(app.launchUrl).origin;
  page.on("pageerror", (e) => errors.push(e.name));
  await page.route("**/*", (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin === origin && request.method() === "GET")
      return route.continue();
    if (
      allowSave &&
      !writes.length &&
      url.origin === origin &&
      url.pathname === "/api/projects/" + owner.id &&
      request.method() === "PUT"
    ) {
      writes.push(request.postDataJSON());
      return route.continue();
    }
    blocked.push([
      request.method(),
      url.origin === origin ? url.pathname : "exterior",
    ]);
    return route.abort();
  });
  const evidence = process.env.DESIGN_PATH_EVIDENCE;
  if (evidence) await mkdir(evidence, { recursive: true });
  const capture = async (state) => {
    if (evidence)
      await page.screenshot({
        path: join(evidence, `design-path-${state}.png`),
        caret: "hide",
        animations: "disabled",
      });
  };
  const open = (id) => page.locator(`.sidebar [data-request="${id}"]`).click();
  const design = page.locator('[data-mode="design"]');
  const tab = page.getByRole("tab", { name: "Path", exact: true });
  const url = page.getByRole("textbox", { name: "请求 URL" });
  const table = page.getByRole("table", { name: "路径参数" });
  const names = table.getByRole("textbox", { name: "路径参数名" });
  const values = table.getByRole("textbox", { name: "路径参数值" });
  const read = () =>
    names.evaluateAll((inputs) =>
      inputs.map((input) => ({ key: input.value, readonly: input.readOnly })),
    );
  const show = async () => {
    await design.click();
    await tab.click();
  };
  await page.goto(app.launchUrl);
  await open(original.id);
  await show();
  await page.locator("#design-description > summary").click();
  assert.deepEqual(await table.getByRole("columnheader").allTextContents(), [
    "参数名",
    "参数值",
    "描述",
  ]);
  const emptyGeometry = await table.evaluate((node) => {
    const { x, y, width, height } = node.getBoundingClientRect();
    return {
      x,
      y,
      width,
      height,
      columns: [...node.tHead.rows[0].cells].map(
        (cell) => cell.getBoundingClientRect().width,
      ),
    };
  });
  assert(Math.abs(emptyGeometry.x - 371) <= 3, JSON.stringify(emptyGeometry));
  assert(Math.abs(emptyGeometry.y - 577) <= 4, JSON.stringify(emptyGeometry));
  assert(
    Math.abs(emptyGeometry.width - 968) <= 3,
    JSON.stringify(emptyGeometry),
  );
  assert(
    Math.abs(emptyGeometry.height - 36) <= 3,
    JSON.stringify(emptyGeometry),
  );
  assert(
    emptyGeometry.columns.every(
      (width) => Math.abs(width - emptyGeometry.width / 3) <= 2,
    ),
  );
  assert.equal(await names.count(), 0);
  await capture("blank");
  const held = await url.elementHandle();
  await url.press("End");
  await page.keyboard.insertText("/{itemId}");
  assert.equal(
    await url.evaluate(
      (element, prior) =>
        element === prior &&
        element === document.activeElement &&
        element.selectionStart === element.value.length,
      held,
    ),
    true,
  );
  assert.equal(await tab.textContent(), "Path(1)");
  assert.deepEqual(await read(), [{ key: "itemId", readonly: true }]);
  assert.equal(
    await table.getByText("string · 必填", { exact: true }).isVisible(),
    true,
  );
  await url.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  assert.equal(await url.inputValue(), endpoint);
  assert.equal(await names.count(), 0);
  await url.press(
    process.platform === "darwin" ? "Meta+Shift+z" : "Control+Shift+z",
  );
  assert.equal(await url.inputValue(), endpoint + "/{itemId}");
  assert.equal(await names.count(), 1);
  await values.first().fill("0007");
  await capture("one");

  await url.evaluate((element) => {
    element.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    element.value += "/{revision}";
    element.dispatchEvent(
      new InputEvent("input", { bubbles: true, isComposing: true }),
    );
  });
  assert.equal(await names.count(), 1);
  await url.dispatchEvent("compositionend");
  assert.deepEqual(await read(), [
    { key: "itemId", readonly: true },
    { key: "revision", readonly: true },
  ]);
  assert.equal(await values.first().inputValue(), "0007");
  await capture("multiple");

  await url.fill(
    endpoint + "/:itemId/{revision}/{revision}?field={notPath}#{fragment}",
  );
  assert.deepEqual(await read(), [
    { key: "itemId", readonly: false },
    { key: "revision", readonly: true },
  ]);
  await url.fill(endpoint);
  assert.deepEqual(await read(), [{ key: "itemId", readonly: false }]);
  assert.equal(await values.first().inputValue(), "0007");
  await url.fill(endpoint + "/{itemId}/{revision}");
  assert.deepEqual(await read(), [
    { key: "itemId", readonly: false },
    { key: "revision", readonly: true },
  ]);
  await open(unrelated.id);
  await tab.click();
  assert.deepEqual(await read(), [{ key: "legacy", readonly: false }]);
  await open(original.id);
  await tab.click();
  assert.equal(await values.first().inputValue(), "0007");

  await page.setViewportSize({ width: 430, height: 830 });
  await page
    .getByRole("button", { name: "＋ 添加参数", exact: true })
    .press("Enter");
  const manual = names.last();
  assert.equal(
    await manual.evaluate((el) => el === document.activeElement),
    true,
  );
  await manual.fill("manual");
  await table.getByRole("button", { name: "删除参数" }).last().press("Enter");
  assert.equal(await names.count(), 2);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  assert.equal(await values.nth(1).isVisible(), true);
  await values.nth(1).fill("v2");
  await capture("narrow");
  assert.deepEqual(writes, []);
  assert.deepEqual(await app.store.get(owner.id), baseline);

  allowSave = true;
  await page.locator("#save").click();
  await page
    .locator("#saved-state")
    .getByText("✓ 已保存", { exact: true })
    .waitFor();
  allowSave = false;
  assert.equal(writes.length, 1);
  const saved = await app.store.get(owner.id);
  assert.deepEqual(
    saved.requests
      .find((r) => r.id === original.id)
      .path.map(({ key, value }) => [key, value]),
    [
      ["itemId", "0007"],
      ["revision", "v2"],
    ],
  );
  assert.deepEqual(saved.requests.find((r) => r.id === unrelated.id).path, [
    unrelatedPath,
  ]);
  const docs = exportOpenAPI(saved);
  assert.deepEqual(
    docs.paths["/verification/{itemId}/{revision}"].get.parameters.map(
      ({ name, example, required }) => ({ name, example, required }),
    ),
    [
      { name: "itemId", example: "0007", required: true },
      { name: "revision", example: "v2", required: true },
    ],
  );
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  console.log(
    "HTTP_DESIGN_PATH_UI_PASS",
    "URL identity/undo/IME/missing-only/narrow/save/export/no dispatch",
  );
} finally {
  try {
    await browser?.close();
  } finally {
    await app?.close();
    await rm(temp, { recursive: true, force: true });
  }
}
