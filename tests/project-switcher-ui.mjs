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
const root = await mkdtemp(join(tmpdir(), "project-search-ui-"));
let app, browser, release;
try {
  app = await createApp({ root, port: 0 });
  const seed = async (name, id) => {
    const fixture = await app.store.create(name);
    fixture.requests.push(
      normalizeRequest({
        id,
        name: "Synthetic " + id,
        method: "GET",
        url: "http://127.0.0.1:1/" + id,
      }),
    );
    await app.store.save(fixture);
    return app.store.get(fixture.id);
  };
  const original = await seed("默认项目", "original");
  const origin = new URL(app.launchUrl).origin;
  const blocked = [],
    errors = [],
    reads = [],
    metrics = {};
  let other,
    signalHeld,
    holdNext = false;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
    locale: "zh-CN",
  });
  page.setDefaultTimeout(7500);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("theme", "light"));
  await page.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.origin !== origin || req.method() !== "GET") {
      blocked.push([req.method(), url.pathname]);
      return route.abort();
    }
    if (/^\/api\/projects\/[^/]+$/.test(url.pathname)) reads.push(url.pathname);
    if (other && holdNext && url.pathname === "/api/projects/" + other.id) {
      holdNext = false;
      await new Promise((resolve) => {
        release = resolve;
        signalHeld();
      });
    }
    return route.continue();
  });
  await page.goto(app.launchUrl);
  const direct = page.locator("#project-select");
  const trigger = page.getByRole("button", { name: "搜索项目", exact: true });
  const popup = page.getByRole("dialog", { name: "搜索项目", exact: true });
  const input = popup.getByRole("searchbox", { name: "项目名称", exact: true });
  const current = popup.getByRole("button", { name: "默认项目", exact: true });
  const name = page.locator("#request-name");
  const owned = direct.locator("option[selected]");
  const focused = (control) =>
    control.evaluate((node) => node === document.activeElement);
  const prefix = process.env.PROJECT_SWITCHER_CAPTURE_PREFIX;
  const capture = (state, narrow = false) =>
    prefix &&
    page.screenshot({
      path: prefix + "-" + state + ".png",
      animations: "disabled",
      caret: "hide",
      ...(narrow ? {} : { clip: { x: 0, y: 0, width: 1363, height: 980 } }),
    });

  await trigger.click();
  await popup.waitFor();
  assert.equal(await direct.isVisible(), true);
  assert.equal(await owned.getAttribute("value"), original.id);
  assert.equal(await trigger.getAttribute("aria-expanded"), "true");
  assert.equal(await focused(input), true);
  assert.equal(await current.getAttribute("aria-current"), "true");
  assert.deepEqual(await popup.getByRole("button").allTextContents(), [
    "默认项目",
  ]);
  metrics.desktop = await popup.boundingBox();
  metrics.search = await input.boundingBox();
  metrics.current = await current.boundingBox();
  console.log("Project switcher geometry", JSON.stringify(metrics));
  await page.mouse.move(870, 440);
  await capture("default");
  assert.deepEqual(metrics.desktop, { x: 486, y: 44, width: 401, height: 367 });
  assert.deepEqual(metrics.search, { x: 507, y: 61, width: 360, height: 32 });
  assert.deepEqual(metrics.current, { x: 507, y: 105, width: 360, height: 40 });
  const initialReads = reads.length;
  await input.fill("No fixture project");
  assert.equal(await popup.getByRole("button").count(), 0);
  assert.equal(await popup.getByRole("status").textContent(), "没有匹配的项目");
  await input.press("Enter");
  assert.equal(reads.length, initialReads);
  await capture("empty");
  const outside = page.locator("#search");
  await outside.click();
  await popup.waitFor({ state: "hidden" });
  assert.equal(await focused(outside), true);
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  await trigger.press("Enter");
  assert.equal(await input.inputValue(), "");
  await input.press("ArrowDown");
  assert.equal(await focused(current), true);
  await current.press("Enter");
  await popup.waitFor({ state: "hidden" });
  assert.equal(await focused(trigger), true);
  assert.equal(reads.length, initialReads);

  await page.setViewportSize({ width: 430, height: 760 });
  await trigger.click();
  metrics.narrow = await popup.boundingBox();
  assert.ok(
    metrics.narrow.x >= 0 && metrics.narrow.x + metrics.narrow.width <= 430,
  );
  assert.ok(
    metrics.narrow.y >= 0 && metrics.narrow.y + metrics.narrow.height <= 760,
  );
  await capture("narrow", true);
  await input.press("Escape");
  await popup.waitFor({ state: "hidden" });
  assert.equal(await focused(trigger), true);
  await page.setViewportSize({ width: 1363, height: 1023 });

  // Registry additions are internal synthetic setup only, not app/browser writes.
  other = await seed("视觉 Fixture Search", "other");
  await page.reload();
  assert.equal(await owned.getAttribute("value"), original.id);
  await name.fill("未保存的合成草稿");
  const found = popup.getByRole("button", { name: other.name, exact: true });
  const searchOther = async () => {
    await trigger.click();
    await input.fill("  FIXTURE SEA  ");
    assert.equal(await popup.getByRole("button").count(), 1);
    assert.equal(await found.isVisible(), true);
  };
  const target = "/api/projects/" + other.id;
  const correspondingReads = () =>
    reads.filter((path) => path === target).length;
  const handleDialog = async (accept, action) => {
    let promptMessage;
    const answer = (prompt) => {
      promptMessage = prompt.message();
      return accept ? prompt.accept() : prompt.dismiss();
    };
    page.once("dialog", answer);
    try {
      await action();
    } finally {
      page.off("dialog", answer);
    }
    assert.equal(promptMessage, "当前修改尚未保存，确定切换项目？");
  };

  await searchOther();
  await handleDialog(false, () => found.click());
  await popup.waitFor({ state: "hidden" });
  assert.equal(await focused(trigger), true);
  assert.equal(correspondingReads(), 0);
  assert.equal(await name.inputValue(), "未保存的合成草稿");
  assert.equal(await owned.getAttribute("value"), original.id);
  await searchOther();
  holdNext = true;
  const held = new Promise((resolve) => {
    signalHeld = resolve;
  });
  await handleDialog(true, () => input.press("Enter"));
  await held;
  await name.fill("加载期间的新草稿");
  release();
  await page.waitForFunction(
    () =>
      document.querySelector("#toast").textContent ===
      "加载期间项目或草稿已变化，未替换当前内容；请重新操作",
  );
  assert.equal(correspondingReads(), 1);
  assert.equal(await name.inputValue(), "加载期间的新草稿");
  assert.equal(await owned.getAttribute("value"), original.id);

  await searchOther();
  await handleDialog(true, () => found.click());
  await owned
    .and(direct.locator(`option[value="${other.id}"]`))
    .waitFor({ state: "attached" });
  assert.equal(await name.count(), 0);
  await page.locator('[data-request="other"]').click();
  assert.equal(await name.inputValue(), "Synthetic other");
  assert.equal(correspondingReads(), 2);
  await direct.selectOption(original.id);
  await owned
    .and(direct.locator(`option[value="${original.id}"]`))
    .waitFor({ state: "attached" });
  assert.equal(await name.count(), 0);
  await page.locator('[data-request="original"]').click();
  assert.equal(await name.inputValue(), "Synthetic original");
  assert.deepEqual(await app.store.get(original.id), original);
  assert.deepEqual(await app.store.get(other.id), other);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  if (prefix)
    await writeFile(
      prefix + ".json",
      JSON.stringify(
        {
          metrics,
          blocked,
          errors,
          destinationReads: correspondingReads(),
        },
        null,
        2,
      ) + "\n",
    );
  console.log(
    "PROJECT_SWITCHER_UI_PASS 401x367/search/empty/430/dirty-cancel/stale-GET/explicit-switch/direct-select/no-writes",
  );
} finally {
  release?.();
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
