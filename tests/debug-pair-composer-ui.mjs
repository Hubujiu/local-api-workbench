import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest, toCurl } from "../src/core.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || "playwright");
const root = await mkdtemp(join(tmpdir(), "workbench-debug-pair-"));
let app, browser;
try {
  app = await createApp({ root, port: 0 });
  const project = await app.store.create("默认项目");
  const url = "http://127.0.0.1:38982/verification";
  const fixture = normalizeRequest({ name: "Verification", url });
  const disabled = {
    key: "KeepCase",
    value: "retained",
    description: "独立禁用参数",
    enabled: false,
    schema: { type: "string" },
  };
  const other = normalizeRequest({
    name: "Other",
    url,
    headers: [disabled],
    query: [disabled],
  });
  project.requests.push(fixture, other);
  await app.store.save(project);

  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const origin = new URL(app.launchUrl).origin;
  const writes = [],
    unexpected = [],
    errors = [];
  const allowlist = async (page) => {
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => {
      const req = route.request();
      const target = new URL(req.url());
      if (target.origin === origin && req.method() === "GET")
        return route.continue();
      if (
        target.origin === origin &&
        req.method() === "PUT" &&
        target.pathname === "/api/projects/" + project.id
      ) {
        writes.push(req.postDataJSON());
        return route.continue();
      }
      unexpected.push([req.method(), target.origin === origin]);
      return route.abort();
    });
  };
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
    locale: "zh-CN",
    colorScheme: "light",
  });
  await page.addInitScript(() => localStorage.setItem("theme", "light"));
  await allowlist(page);
  await page.goto(app.launchUrl);
  const tab = (kind) => page.locator(`[data-param="${kind}"]`);
  const composer = (kind) => page.locator(`[data-debug-pair-name="${kind}"]`);
  const real = (kind, index, field) =>
    page.locator(`[data-pair="${kind}:${index}:${field}"]`);
  const pick = (request) =>
    page.locator(`#tree [data-request="${request.id}"]`);
  await page.locator('[data-mode="debug"]').click();

  async function empty(kind, name) {
    await tab(kind).click();
    const table = page.locator(
      kind === "headers" ? ".debug-header-pairs" : ".debug-pairs-empty",
    );
    const composerRow = table.locator("tbody > tr");
    await composerRow.waitFor();
    assert.equal(await table.locator("thead th").count(), 3);
    assert.equal(await real(kind, 0, "key").count(), 0);
    assert.equal(await composer(kind).inputValue(), "");
    const boxes = await table.locator("thead th").evaluateAll((cells) =>
      cells.map((cell) => {
        const { x, y, width, height } = cell.getBoundingClientRect();
        return { x, y, width, height };
      }),
    );
    const headerHeight = kind === "headers" ? 35 : 36;
    for (const column of boxes) assert.equal(column.height, headerHeight);
    const primary = boxes.map((column) => column.width);
    assert.ok(
      Math.max(...primary) - Math.min(...primary) <= 4,
      `${kind} primary columns should be near-equal; measured ${primary.join(", ")} px`,
    );
    assert.ok((await composerRow.boundingBox()).height >= 36);
    if (process.env.DEBUG_PAIRS_CAPTURE_PREFIX)
      await page.screenshot({
        path: `${process.env.DEBUG_PAIRS_CAPTURE_PREFIX}-${name}.png`,
        clip: { x: 0, y: 0, width: 1363, height: 980 },
        caret: "hide",
        animations: "disabled",
      });
    return { boxes, composer: await composerRow.boundingBox() };
  }
  const header = await empty("headers", "header");
  const query = await empty("query", "query");
  await tab("headers").click();
  await page.getByRole("button", { name: "公共参数（Header）" }).press("Tab");
  const nextHeader = page.getByRole("checkbox", { name: "启用新 Header 参数" });
  assert.equal(
    await nextHeader.evaluate((el) => el === document.activeElement),
    true,
  );
  await page.keyboard.press("Tab");
  assert.equal(
    await composer("headers").evaluate((el) => el === document.activeElement),
    true,
  );
  await page.keyboard.type("  ");
  await page.keyboard.press("Tab");
  await tab("query").click();
  await tab("headers").click();
  assert.equal(await composer("headers").inputValue(), "");
  assert.equal(await real("headers", 0, "key").count(), 0);
  assert.deepEqual(writes, []);
  assert.equal(
    await page
      .locator("#saved-state")
      .getByText("✓ 已保存", { exact: true })
      .count(),
    1,
  );

  await tab("query").click();
  const equality = page.getByRole("checkbox", {
    name: "空值 Query 参数添加等号",
  });
  assert.equal(
    await page.locator(".debug-pairs-table thead #query-add-equal").count(),
    1,
  );
  assert.equal(await equality.isChecked(), true);
  assert.equal(
    await equality.getAttribute("title"),
    "当参数值为空时，自动添加等号",
  );
  assert.equal(
    await equality.evaluate(
      (el) =>
        document.getElementById(el.getAttribute("aria-describedby"))
          .textContent,
    ),
    "仅影响参数表中的空值；URL 内已有查询保持原样。",
  );
  await page.keyboard.press("Tab");
  await equality.focus();
  assert.equal(
    await equality.evaluate(
      (el) => getComputedStyle(el.nextElementSibling).outlineStyle,
    ),
    "solid",
  );
  await page.keyboard.press("Space");
  assert.equal(await equality.isChecked(), false);
  assert.equal(
    await equality.getAttribute("title"),
    "当参数值为空时，不添加等号",
  );
  assert.equal(await page.locator("#url").inputValue(), url);
  if (process.env.DEBUG_PAIRS_CAPTURE_PREFIX) {
    await equality.blur();
    await page.mouse.move(800, 87);
    await page.screenshot({
      path: `${process.env.DEBUG_PAIRS_CAPTURE_PREFIX}-query-off.png`,
      clip: { x: 0, y: 0, width: 1363, height: 980 },
      caret: "hide",
      animations: "disabled",
    });
  }
  await equality.press("Space");
  assert.equal(await equality.isChecked(), true);
  assert.deepEqual(writes, []);

  await tab("headers").click();
  await composer("headers").click();
  await page.keyboard.type("X-Verification");
  assert.equal(await real("headers", 0, "key").inputValue(), "X-Verification");
  assert.equal(await real("headers", 1, "key").count(), 0);
  await page.keyboard.press("Tab");
  assert.equal(
    await real("headers", 0, "value").evaluate(
      (el) => el === document.activeElement,
    ),
    true,
  );
  await page.keyboard.type("local-only");
  await page.locator('[data-define-pair="headers:0"]').click();
  await page.locator("#parameter-description").fill("复查说明");
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await tab("query").click();
  await composer("query").fill("flag");
  await page.locator("#query-add-equal").uncheck();

  await pick(other).click();
  await tab("query").click();
  assert.equal(await real("query", 0, "key").inputValue(), disabled.key);
  assert.equal(
    await page.locator('[data-pair-enabled="query:0"]').isChecked(),
    false,
  );
  await pick(fixture).click();
  await tab("query").click();
  assert.equal(await real("query", 0, "key").inputValue(), "flag");
  assert.equal(await page.locator("#query-add-equal").isChecked(), false);
  assert.deepEqual(writes, []);
  const [saved] = await Promise.all([
    page.waitForResponse((response) => response.request().method() === "PUT"),
    page.locator("#save").click(),
  ]);
  assert.equal(saved.status(), 200);
  assert.equal(writes.length, 1);
  const stored = await app.store.get(project.id);
  const request = stored.requests.find((item) => item.id === fixture.id);
  assert.equal(request.headers.length, 1);
  assert.equal(request.headers[0].description, "复查说明");
  assert.equal(request.headers[0].value, "local-only");
  assert.deepEqual(request.query, [{ key: "flag", value: "", enabled: true }]);
  assert.equal(request.queryAddEqual, false);
  const exportFixture = { ...request, url: url + "?rawFlag&raw=a%2Bb" };
  assert.ok(toCurl(exportFixture).includes("?rawFlag&raw=a%2Bb&flag'"));
  assert.ok(
    toCurl({ ...exportFixture, queryAddEqual: true }).includes(
      "?rawFlag&raw=a%2Bb&flag='",
    ),
  );

  const retained = stored.requests.find((item) => item.id === other.id);
  assert.deepEqual(retained.headers, [disabled]);
  assert.deepEqual(retained.query, [disabled]);
  await page.reload();
  await pick(fixture).click();
  await page.locator('[data-mode="debug"]').click();
  await tab("headers").click();
  assert.equal(await real("headers", 0, "value").inputValue(), "local-only");
  await tab("query").click();
  assert.equal(await real("query", 0, "key").inputValue(), "flag");
  assert.equal(await page.locator("#query-add-equal").isChecked(), false);

  const touch = await browser.newPage({
    viewport: { width: 680, height: 760 },
    hasTouch: true,
  });
  await allowlist(touch);
  await touch.goto(app.launchUrl);
  await touch.locator('[data-mode="debug"]').tap();
  await touch.locator('[data-param="headers"]').tap();
  await touch.locator('[data-debug-pair-name="headers"]').tap();
  await touch.keyboard.type("X-Narrow");
  assert.equal(
    await touch.locator('[data-pair="headers:1:key"]').inputValue(),
    "X-Narrow",
  );
  await touch.locator('[data-dynamic-pair="headers:1"]').tap();
  await touch.locator("#dialog").waitFor();
  await touch.getByRole("button", { name: "关闭", exact: true }).tap();
  assert.equal(
    await touch.evaluate(() => document.documentElement.scrollWidth),
    680,
  );
  await touch.setViewportSize({ width: 360, height: 760 });
  await touch.locator('[data-param="query"]').tap();
  const touchEquality = touch.getByRole("checkbox", {
    name: "空值 Query 参数添加等号",
  });
  assert.equal(await touchEquality.isChecked(), false);
  await touchEquality.tap();
  assert.equal(await touchEquality.isChecked(), true);
  assert.equal(
    await touch.evaluate(() => document.documentElement.scrollWidth),
    360,
  );
  assert.equal(writes.length, 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log(JSON.stringify({ header, query }));
  console.log(
    "DEBUG_PAIR_COMPOSER_UI_PASS empty/keyboard/touch/ownership/save-reload/query-equals/curl/no-dispatch",
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
