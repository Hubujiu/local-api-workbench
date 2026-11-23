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
const home = await mkdtemp(join(tmpdir(), "workbench-debug-cookie-"));
let browser, app;
try {
  app = await createApp({ root: home, port: 0 });
  const owner = await app.store.create("Cookie fixture");
  const projectB = await app.store.create("Independent cookie fixture");
  const url = "http://127.0.0.1:38982/verification";
  const primary = normalizeRequest({
    id: "primary-cookie",
    name: "Verification",
    url,
  });
  const imported = normalizeRequest({
    id: "independent-cookie",
    name: "Independent",
    url,
    cookieEncoding: "apipost-name",
    cookies: [
      {
        key: "retained",
        value: "0002",
        enabled: false,
        required: true,
        description: "保留的 Cookie 定义",
        schema: { type: "string", minLength: 1 },
      },
    ],
  });
  owner.requests.push(primary, imported);
  await app.store.save(owner);
  const baseline = await app.store.get(owner.id);
  const otherBaseline = await app.store.get(projectB.id);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
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
  const origin = new URL(app.launchUrl).origin;
  const ownerPath = "/api/projects/" + owner.id;
  const writes = [],
    blocked = [],
    errors = [];
  let maySave = false;
  page.on("pageerror", (error) => errors.push(error.name));
  await page.route("**/*", (route) => {
    const req = route.request(),
      dest = new URL(req.url());
    if (dest.origin === origin && req.method() === "GET")
      return route.continue();
    if (
      maySave &&
      !writes.length &&
      dest.origin === origin &&
      dest.pathname === ownerPath &&
      req.method() === "PUT"
    ) {
      writes.push(req.postDataJSON());
      return route.continue();
    }
    blocked.push(req.method());
    return route.abort();
  });
  const evidence = process.env.HTTP_DEBUG_COOKIE_EVIDENCE;
  if (evidence) await mkdir(evidence, { recursive: true });
  const capture = async (state) => {
    if (!evidence) return;
    await page.screenshot({
      path: join(evidence, "debug-cookie-" + state + ".png"),
      caret: "hide",
      animations: "disabled",
    });
  };
  const pick = (id) => page.locator(`.sidebar [data-request="${id}"]`).click();
  const cookieTab = page.locator('.param-tabs [data-param="cookies"]');
  const table = page.getByRole("table", {
    name: "Cookie 请求参数",
    exact: true,
  });
  const header = table.getByRole("checkbox", {
    name: "启用全部 Cookie 参数（仅参数表）",
  });
  const next = table.getByRole("checkbox", { name: "启用新 Cookie 参数" });
  const composer = table.getByRole("textbox", { name: "新 Cookie 参数名" });
  const row = (index, field) =>
    table.locator(`[data-pair="cookies:${index}:${field}"]`);
  const rowChecks = table.getByRole("checkbox", {
    name: "启用参数",
    exact: true,
  });
  const state = (locator) =>
    locator.evaluate((node) => [
      node.checked,
      node.indeterminate,
      node.disabled,
    ]);
  const near = (value, expected, tolerance = 3) =>
    assert(
      Math.abs(value - expected) <= tolerance,
      `${value} not within ${tolerance} of ${expected}`,
    );
  await page.goto(app.launchUrl);
  await pick(primary.id);
  await page.locator('[data-mode="debug"]').click();
  await cookieTab.press("Enter");
  assert.equal(await cookieTab.textContent(), "Cookie");
  assert.deepEqual(await state(header), [true, false, true]);
  assert.deepEqual(await state(next), [true, false, false]);
  assert.equal(await rowChecks.count(), 0);
  assert.equal(await table.getByRole("columnheader").count(), 3);
  assert.equal(await page.locator("#cookie-encoding").inputValue(), "raw");
  assert.equal(await page.locator("#cookie-manager").isVisible(), true);
  await capture("empty-desktop");
  const layout = await table.evaluate((node) => {
    const box = (el) => {
      const { x, y, width, height } = el.getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      table: box(node),
      header: box(node.tHead.rows[0]),
      columns: [...node.tHead.rows[0].cells].map(box),
      headerCheck: box(node.querySelector("#debug-cookie-enable-all")),
      composerCheck: box(node.querySelector("[data-debug-cookie-next]")),
      composerName: box(node.querySelector("[data-debug-pair-name]")),
    };
  });
  console.log("HTTP_DEBUG_COOKIE_LAYOUT", JSON.stringify(layout));
  near(layout.table.x, 371);
  near(layout.table.y, 233);
  near(layout.table.width, 976);
  near(layout.header.height, 36);
  for (const column of layout.columns)
    near(column.width, layout.table.width / 3);
  near(layout.headerCheck.x + layout.headerCheck.width / 2, 400);
  near(layout.composerCheck.x + layout.composerCheck.width / 2, 400);
  near(layout.composerCheck.y + layout.composerCheck.height / 2, 288);
  near(layout.composerName.x, 415);
  await composer.fill("   ");
  assert.equal(await rowChecks.count(), 0);
  assert.deepEqual(await app.store.get(owner.id), baseline);
  await composer.fill("visual_cookie");
  assert.equal(
    await row(0, "key").evaluate((node) => node === document.activeElement),
    true,
  );
  assert.equal(await composer.inputValue(), "");
  await row(0, "value").fill("0007");
  assert.deepEqual(await state(header), [true, false, false]);
  assert.equal(await cookieTab.textContent(), "Cookie (1)");
  await capture("named-desktop");
  near(
    await row(0, "value").evaluate((el) => {
      const css = getComputedStyle(el);
      return (
        el.getBoundingClientRect().x +
        parseFloat(css.paddingLeft) +
        parseFloat(css.borderLeftWidth)
      );
    }),
    713,
  );

  await next.press("Space");
  assert.equal(await next.isChecked(), false);
  assert.equal(await rowChecks.count(), 1);
  await composer.fill("keep_disabled");
  await row(1, "value").fill("0008");
  assert.equal(await next.isChecked(), true);
  assert.deepEqual(await state(header), [false, true, false]);
  assert.deepEqual(
    await rowChecks.evaluateAll((nodes) => nodes.map((el) => el.checked)),
    [true, false],
  );
  await header.press("Space");
  assert.deepEqual(await state(header), [true, false, false]);
  assert.deepEqual(
    await rowChecks.evaluateAll((nodes) => nodes.map((el) => el.checked)),
    [true, true],
  );
  await header.press("Space");
  assert.deepEqual(await state(header), [false, false, false]);
  assert.deepEqual(
    await rowChecks.evaluateAll((nodes) => nodes.map((el) => el.checked)),
    [false, false],
  );
  await rowChecks.first().press("Space");
  assert.deepEqual(await state(header), [false, true, false]);

  const stale = await composer.elementHandle();
  const staleRowActions = await table
    .locator(
      '[data-remove-pair="cookies:0"], [data-dynamic-pair="cookies:0"], [data-define-pair="cookies:0"], [data-dictionary-pair="cookies:0"]',
    )
    .elementHandles();
  assert.equal(staleRowActions.length, 4);
  await table.locator('[data-dynamic-pair="cookies:0"]').click();
  const dialog = page.getByRole("dialog", { name: "动态参数值" });
  await dialog.waitFor();
  // Simulate a rerender arriving while the open editor owns the old row.
  // Normal clicks cannot target the background of a modal dialog.
  await page
    .locator(`.sidebar [data-request="${imported.id}"]`)
    .evaluate((tab) => tab.click());
  await dialog.locator("#dynamic-value").fill('"must-not-cross-modal"');
  await dialog.locator("#dialog-save").click();
  await page
    .locator("#toast")
    .getByText("Cookie 参数草稿已变化，请重新打开编辑器", { exact: true })
    .waitFor();
  assert.equal(await dialog.isVisible(), true);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await cookieTab.click();
  for (const action of staleRowActions)
    await action.evaluate((button) => {
      if (button.isConnected) throw Error("Expected a detached row action");
      button.click();
    });
  assert.equal(await page.locator("#dialog[open]").count(), 0);
  await stale.evaluate((input) => {
    input.value = "must-not-cross-request";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  });
  assert.deepEqual(await state(header), [false, false, false]);
  assert.equal(await row(0, "key").inputValue(), "retained");
  assert.equal(await row(0, "value").inputValue(), "0002");
  assert.equal(await rowChecks.count(), 1);
  assert.equal(
    await page.locator("#cookie-encoding").inputValue(),
    "apipost-name",
  );
  assert.equal(await table.getByText("保留的 Cookie 定义").isVisible(), true);
  await pick(primary.id);
  await cookieTab.click();

  await page.setViewportSize({ width: 430, height: 830 });
  await page.locator("#theme").press("Enter");
  assert.equal(
    await page.evaluate(() => document.body.classList.contains("dark")),
    true,
  );
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  assert.equal(
    await table.getByRole("button", { name: "删除参数" }).first().isVisible(),
    true,
  );
  assert.equal(await row(0, "value").inputValue(), "0007");
  await capture("named-narrow-dark");
  assert.deepEqual(await app.store.get(owner.id), baseline);
  assert.deepEqual(await app.store.get(projectB.id), otherBaseline);
  assert.deepEqual(writes, []);
  assert.deepEqual(blocked, []);

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
  const savedPrimary = saved.requests.find((item) => item.id === primary.id);
  assert.equal(savedPrimary.cookies[0].dynamic, undefined);
  assert.deepEqual(
    savedPrimary.cookies.map(({ key, value, enabled }) => [
      key,
      value,
      enabled,
    ]),
    [
      ["visual_cookie", "0007", true],
      ["keep_disabled", "0008", false],
    ],
  );
  assert.deepEqual(
    saved.requests.find((item) => item.id === imported.id).cookies,
    baseline.requests.find((item) => item.id === imported.id).cookies,
  );
  assert.deepEqual(saved.history, baseline.history);
  const switchOwner = page.locator("#project-select");
  await switchOwner.selectOption(projectB.id);
  await page.waitForFunction(
    (id) =>
      document.querySelector("#project-select option[selected]")?.value === id,
    projectB.id,
  );
  assert.equal(await table.count(), 0);
  await stale.evaluate((input) => {
    input.value = "must-not-cross-project";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  });
  assert.deepEqual(await app.store.get(projectB.id), otherBaseline);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  console.log(
    "HTTP_DEBUG_COOKIE_UI_PASS keyboard composition, tri-state, request/project isolation, one explicit save, zero dispatch",
  );
} finally {
  try {
    await browser?.close();
  } finally {
    await app?.close();
    await rm(home, { recursive: true, force: true });
  }
}
