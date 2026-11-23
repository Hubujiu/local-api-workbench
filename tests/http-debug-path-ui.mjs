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
const temp = await mkdtemp(join(tmpdir(), "workbench-debug-path-"));
const endpoint = "http://127.0.0.1:38982/verification";
const syntheticResponse = '{"fixture":"retained-response"}';
let app, browser;
try {
  app = await createApp({ root: temp, port: 0 });
  const owner = await app.store.create("HTTP Debug Path fixture");
  const primary = normalizeRequest({
    id: "debug-path",
    name: "Verification",
    url: endpoint,
  });
  const untouched = normalizeRequest({
    id: "other-path",
    name: "Independent",
    url: endpoint + "/other/{legacy}",
    path: [{ key: "legacy", value: "0001", enabled: true }],
  });
  owner.requests.push(primary, untouched);
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
  page.setDefaultTimeout(7000);
  await page.addInitScript((id) => {
    localStorage.setItem("theme", "light");
    sessionStorage.setItem("project", id);
  }, owner.id);
  const blocked = [],
    writes = [],
    syntheticExecutions = [],
    errors = [];
  let maySave = false,
    seedResponse = false;
  const origin = new URL(app.launchUrl).origin;
  const ownerPath = "/api/projects/" + owner.id;
  page.on("pageerror", (error) => errors.push(error.name));
  await page.route("**/*", (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin === origin && request.method() === "GET")
      return route.continue();
    if (
      seedResponse &&
      !syntheticExecutions.length &&
      url.origin === origin &&
      url.pathname === ownerPath + "/execute" &&
      request.method() === "POST"
    ) {
      syntheticExecutions.push(request.postDataJSON());
      // Seed only the browser's existing response display. Nothing reaches the execution handler or the target.
      return route.fulfill({
        json: {
          status: 200,
          duration: 2,
          size: 31,
          body: syntheticResponse,
          headers: { "content-type": "application/json" },
        },
      });
    }
    if (
      maySave &&
      !writes.length &&
      url.origin === origin &&
      url.pathname === ownerPath &&
      request.method() === "PUT"
    ) {
      writes.push(request.postDataJSON());
      return route.continue();
    }
    blocked.push([
      request.method(),
      url.origin === origin ? url.pathname : "external",
    ]);
    return route.abort();
  });
  const evidence = process.env.HTTP_DEBUG_PATH_EVIDENCE;
  if (evidence) await mkdir(evidence, { recursive: true });
  const capture = async (state) => {
    if (evidence)
      await page.screenshot({
        path: join(evidence, `debug-path-${state}.png`),
        caret: "hide",
        animations: "disabled",
      });
  };
  const mode = (name) => page.locator(`[data-mode="${name}"]`);
  const debugTab = page.locator('.param-tabs [data-param="path"]');
  const designTab = page.locator("#design-tab-path");
  const url = page.getByRole("textbox", { name: "请求 URL" });
  const table = page.getByRole("table", { name: "路径参数" });
  const names = table.getByRole("textbox", { name: "路径参数名" });
  const values = table.getByRole("textbox", { name: "路径参数值" });
  const response = page.locator("#http-response-text");
  const keyState = () =>
    names.evaluateAll((nodes) =>
      nodes.map((field) => [field.value, field.readOnly]),
    );
  const openRequest = (id) =>
    page.locator(`.sidebar [data-request="${id}"]`).click();
  const rects = () =>
    table.evaluate((node) => {
      const rect = (element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        whole: rect(node),
        cols: [...node.tHead.rows[0].cells].map(rect),
        rows: [...node.tBodies[0].rows].map(rect),
      };
    });
  const near = (actual, expected, tolerance = 3) =>
    assert(
      Math.abs(actual - expected) <= tolerance,
      `${actual} not within ${tolerance} of ${expected}`,
    );

  await page.goto(app.launchUrl);
  await openRequest(primary.id);
  await debugTab.press("Enter");
  assert.deepEqual(await table.getByRole("columnheader").allTextContents(), [
    "参数名",
    "参数值",
    "描述",
  ]);
  assert.equal(await debugTab.textContent(), "Path");
  assert.equal(await names.count(), 0);
  await capture("blank");
  const blank = await rects();
  console.log("HTTP_DEBUG_PATH_BLANK_GEOMETRY", JSON.stringify(blank));
  near(blank.whole.x, 371);
  near(blank.whole.y, 233);
  near(blank.whole.width, 976);
  near(blank.whole.height, 37);
  assert(
    blank.cols.every(
      ({ width }) => Math.abs(width - blank.whole.width / 3) <= 2,
    ),
  );

  const inputNode = await url.elementHandle();
  await url.press("End");
  await page.keyboard.insertText("/{itemId}");
  assert.equal(
    await url.evaluate(
      (element, before) =>
        element === before &&
        element === document.activeElement &&
        element.selectionStart === element.value.length,
      inputNode,
    ),
    true,
  );
  assert.deepEqual(await keyState(), [["itemId", true]]);
  assert.equal(await debugTab.textContent(), "Path (1)");
  assert.equal(await table.getByText("string", { exact: true }).count(), 1);
  assert.equal(await table.getByRole("img", { name: "必填" }).count(), 1);
  await url.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  assert.equal(await url.inputValue(), endpoint);
  assert.equal(await names.count(), 0);
  await url.press(
    process.platform === "darwin" ? "Meta+Shift+z" : "Control+Shift+z",
  );
  assert.deepEqual(await keyState(), [["itemId", true]]);
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
  assert.deepEqual(await keyState(), [
    ["itemId", true],
    ["revision", true],
  ]);
  assert.equal(await debugTab.textContent(), "Path (2)");
  assert.equal(await values.first().inputValue(), "0007");
  await capture("multiple");
  const multiple = await rects();
  console.log("HTTP_DEBUG_PATH_MULTIPLE_GEOMETRY", JSON.stringify(multiple));
  near(multiple.rows[0].y, 270);
  near(multiple.rows[1].y, 306);
  near(multiple.rows[1].height, 36);
  assert.deepEqual(syntheticExecutions, []);
  assert.deepEqual(writes, []);

  // Demonstrate that a populated existing response is preserved without real dispatch.
  await values.last().fill("v2");
  seedResponse = true;
  await page.locator("#send").click();
  await response.waitFor();
  seedResponse = false;
  assert.equal(syntheticExecutions.length, 1);
  const responseNode = await response.elementHandle();
  const responseText = await response.textContent();
  assert.match(responseText, /retained-response/);
  await url.fill(endpoint + "/{itemId}/{revision}/{extra}");
  assert.equal(
    await response.evaluate((node, before) => node === before, responseNode),
    true,
  );
  assert.equal(await response.textContent(), responseText);
  assert.equal(await names.count(), 3);
  await mode("design").click();
  assert.equal(await designTab.textContent(), "Path(3)");
  await designTab.click();
  assert.deepEqual(await keyState(), [
    ["itemId", true],
    ["revision", true],
    ["extra", true],
  ]);
  await url.fill(endpoint + "/{itemId}/{revision}?query={notPath}#ignored");
  assert.equal(await names.count(), 2);
  assert.equal(await values.first().inputValue(), "0007");
  await mode("debug").click();
  await debugTab.click();
  assert.equal(await response.textContent(), responseText);
  assert.equal(await debugTab.textContent(), "Path (2)");
  await url.fill(endpoint + "/:itemId/{revision}");
  assert.deepEqual(await keyState(), [
    ["itemId", false],
    ["revision", true],
  ]);
  await url.fill(endpoint + "/{itemId}/{revision}");
  assert.deepEqual(await keyState(), [
    ["itemId", false],
    ["revision", true],
  ]);

  await openRequest(untouched.id);
  await debugTab.click();
  assert.deepEqual(await keyState(), [["legacy", false]]);
  assert.equal(await response.count(), 0);
  await openRequest(primary.id);
  await debugTab.click();
  assert.equal(await response.textContent(), responseText);

  await page.setViewportSize({ width: 430, height: 830 });
  await page.locator("#theme").press("Enter");
  assert.equal(
    await page.evaluate(() => document.body.classList.contains("dark")),
    true,
  );
  const add = page.getByRole("button", { name: "＋ 添加参数", exact: true });
  await add.press("Enter");
  const manual = names.last();
  assert.equal(
    await manual.evaluate((node) => node === document.activeElement),
    true,
  );
  await manual.fill("temporaryManual");
  const manualRow = table
    .getByRole("row")
    .filter({ has: page.locator('[data-pair="path:2:key"]') });
  const remove = manualRow.getByRole("button", { name: "删除参数" });
  assert.equal(await remove.isVisible(), true);
  await remove.press("Enter");
  assert.equal(await names.count(), 2);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  assert.equal(await values.last().inputValue(), "v2");
  await capture("narrow-dark");
  assert.deepEqual(await app.store.get(owner.id), baseline);
  assert.deepEqual(writes, []);

  await page.setViewportSize({ width: 1363, height: 1023 });
  maySave = true;
  await page.locator("#save").click();
  await page
    .locator("#saved-state")
    .getByText("✓ 已保存", { exact: true })
    .waitFor();
  maySave = false;
  assert.equal(writes.length, 1);
  const saved = await app.store.get(owner.id);
  assert.deepEqual(
    saved.requests
      .find((entry) => entry.id === primary.id)
      .path.map(({ key, value }) => [key, value]),
    [
      ["itemId", "0007"],
      ["revision", "v2"],
    ],
  );
  assert.deepEqual(
    saved.requests.find((entry) => entry.id === untouched.id).path,
    untouched.path,
  );
  assert.deepEqual(saved.history, baseline.history);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  assert.equal(syntheticExecutions.length, 1);
  console.log(
    "HTTP_DEBUG_PATH_UI_PASS",
    "path ownership / preserved mocked response / one explicit save / zero target dispatches",
  );
} finally {
  try {
    await browser?.close();
  } finally {
    await app?.close();
    await rm(temp, { recursive: true, force: true });
  }
}
