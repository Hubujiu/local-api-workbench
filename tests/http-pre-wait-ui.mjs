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
const home = await mkdtemp(join(tmpdir(), "workbench-pre-wait-"));
let app, browser;
try {
  app = await createApp({ root: home, port: 0 });
  const owner = await app.store.create("Wait fixture");
  const url = "http://127.0.0.1:38982/verification";
  const a = normalizeRequest({
    id: "ordinary-wait",
    name: "Verification",
    url,
  });
  const variable = { type: "set", name: "fixtureVariable", value: "unchanged" };
  const b = normalizeRequest({
    id: "other-wait",
    name: "Isolation",
    url,
    before: [variable],
  });
  owner.requests.push(a, b);
  await app.store.save(owner);
  const baseline = await app.store.get(owner.id);
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
  const writes = [],
    blocked = [],
    errors = [];
  let saveAllowed = false;
  page.on("pageerror", (error) => errors.push(error.name));
  await page.route("**/*", (route) => {
    const req = route.request(),
      dest = new URL(req.url());
    if (dest.origin === origin && req.method() === "GET")
      return route.continue();
    if (
      saveAllowed &&
      !writes.length &&
      dest.origin === origin &&
      dest.pathname === "/api/projects/" + owner.id &&
      req.method() === "PUT"
    ) {
      writes.push(req.method());
      return route.continue();
    }
    blocked.push([req.method(), dest.pathname]);
    return route.abort();
  });
  const evidence = process.env.HTTP_PRE_WAIT_EVIDENCE;
  if (evidence) await mkdir(evidence, { recursive: true });
  const capture = async (state) => {
    if (evidence)
      await page.screenshot({
        path: join(evidence, "http-pre-wait-" + state + ".png"),
        caret: "hide",
        animations: "disabled",
      });
  };
  const pre = page.locator('[data-param="before"]');
  const add = page.locator("#http-pre-add");
  const menu = page.locator("#http-pre-menu");
  const wait = menu.getByRole("menuitem", { name: "等待", exact: true });
  const cards = page.locator("[data-pre-wait-row]");
  const card = (index) => cards.nth(index);
  const time = (index) =>
    card(index).getByRole("textbox", { name: "等待时长（毫秒）" });
  const enabled = (index) =>
    card(index).getByRole("switch", { name: "启用等待" });
  const status = () => page.locator("#saved-state").textContent();
  const toast = (message) =>
    page.locator("#toast").getByText(message, { exact: true }).waitFor();
  const pick = async (request) => {
    await page.locator(`.sidebar [data-request="${request.id}"]`).click();
    await pre.click();
  };
  const addWait = async () => {
    await add.press("ArrowUp");
    await wait.press("Enter");
  };
  const near = (a, b, tolerance = 3) =>
    assert(
      Math.abs(a - b) <= tolerance,
      `${a} not within ${tolerance} of ${b}`,
    );
  await page.goto(app.launchUrl);
  await page.locator('[data-mode="debug"]').click();
  await pick(a);
  await add.press("ArrowUp");
  assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), [
    "自定义脚本",
    "数据库",
    "等待",
  ]);
  assert.equal(
    await wait.evaluate((el) => el === document.activeElement),
    true,
  );
  await capture("desktop-menu");
  await wait.press("Enter");
  assert.equal(
    await time(0).evaluate((el) => el === document.activeElement),
    true,
  );
  assert.equal(await time(0).inputValue(), "1000");
  assert.equal(await enabled(0).isChecked(), true);
  assert.equal(await status(), "● 未保存");
  const box = await card(0).boundingBox();
  const toggle = await enabled(0).boundingBox();
  const label = await card(0).locator(".http-pre-wait-title").boundingBox();
  const duration = await card(0)
    .locator(".http-pre-wait-duration")
    .boundingBox();
  console.log(
    "HTTP_PRE_WAIT_GEOMETRY",
    JSON.stringify({ box, toggle, label, duration }),
  );
  near(box.x, 385);
  near(box.y, 233);
  near(box.height, 42);
  near(toggle.x, 397);
  near(toggle.width, 29);
  near(label.x, 438);
  near(duration.x, 492);
  near(duration.width, 218);
  await time(0).fill("1250");
  await time(0).press("Tab");
  assert.equal(await time(0).inputValue(), "1250");
  await capture("desktop-enabled");
  await enabled(0).press("Space");
  assert.equal(await enabled(0).isChecked(), false);
  assert.equal(await time(0).inputValue(), "1250");
  await capture("desktop-disabled");

  await time(0).fill("1.25");
  assert.equal(await time(0).getAttribute("aria-invalid"), "true");
  await page.locator("#save").click();
  await toast("请修正前置等待时长后再保存或发送");
  // Even a faulty UI path cannot dispatch: the test aborts every non-GET
  // request except the one later, explicitly armed owner PUT.
  await page.locator("#toast").evaluate((el) => {
    el.style.display = "none";
  });
  await page.locator("#send").click();
  await toast("请修正前置等待时长后再保存或发送");
  await pick(b);
  await page.locator("#toast").evaluate((el) => {
    el.style.display = "none";
  });
  await page.locator("#save").click();
  await toast("请修正前置等待时长后再保存或发送");
  assert.deepEqual(blocked, []);
  await pick(a);
  assert.equal(await time(0).inputValue(), "1.25");
  await time(0).press("Escape");
  assert.equal(await time(0).inputValue(), "1250");
  assert.equal(await time(0).getAttribute("aria-invalid"), "false");

  await addWait();
  assert.equal(await time(1).inputValue(), "1000");
  await time(1).fill("10000");
  await enabled(0).press("Space");
  await toast("启用的前置等待累计不能超过 10000 毫秒");
  assert.equal(await enabled(0).isChecked(), false);
  assert.equal(await time(0).inputValue(), "1250");
  const oldTime = await time(0).elementHandle();
  const oldToggle = await enabled(0).elementHandle();
  await pick(b);
  await addWait();
  assert.equal(await cards.count(), 1);
  await oldTime.evaluate((el) => {
    if (el.isConnected)
      throw Error("Expected the old wait duration to be detached");
    el.value = "9999";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await oldToggle.evaluate((el) => {
    if (el.isConnected)
      throw Error("Expected the old wait switch to be detached");
    el.checked = false;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  assert.equal(await time(0).inputValue(), "1000");
  assert.equal(await enabled(0).isChecked(), true);
  assert.equal(await card(0).getAttribute("data-operation-index"), "1");
  await card(0).getByRole("button", { name: "上移", exact: true }).click();
  assert.equal(await card(0).getAttribute("data-operation-index"), "0");
  assert.match(
    await page.locator('[data-operation-index="1"]').innerText(),
    /fixtureVariable/,
  );
  await card(0).getByRole("button", { name: "下移", exact: true }).click();
  assert.equal(await card(0).getAttribute("data-operation-index"), "1");
  const remove = () =>
    card(0).getByRole("button", { name: "删除等待" }).click();
  page.once("dialog", (dialog) => dialog.dismiss());
  await remove();
  assert.equal(await cards.count(), 1);
  page.once("dialog", (dialog) => dialog.accept());
  await remove();
  assert.equal(await cards.count(), 0);
  assert.match(
    await page.locator('[data-operation-index="0"]').innerText(),
    /fixtureVariable/,
  );

  await pick(a);
  assert.equal(await time(0).inputValue(), "1250");
  assert.equal(await enabled(0).isChecked(), false);
  assert.equal(await time(1).inputValue(), "10000");
  await page.locator('[data-mode="cases"]').click();
  await page.locator("#create-case").click();
  const plan = page.getByRole("dialog", { name: "新建执行计划", exact: true });
  await plan.locator("#dialog-save").click();
  await toast(
    "冻结计划模板不支持手动调试前置等待；请在普通 HTTP 调试中执行，或使用项目备份保留定义",
  );
  assert.equal(await plan.isVisible(), true);
  await page.keyboard.press("Escape");
  await plan.waitFor({ state: "hidden" });
  // A real mode change rerenders from the current page and proves the
  // rejection did not silently switch the underlying page to Plans.
  await page.locator('[data-mode="debug"]').click();
  await pre.click();
  assert.equal(await time(0).inputValue(), "1250");
  assert.equal(await time(1).inputValue(), "10000");
  assert.deepEqual(blocked, []);
  await page.setViewportSize({ width: 430, height: 830 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  assert.equal(await time(0).isVisible(), true);
  assert.equal(
    await card(0).getByRole("button", { name: "删除等待" }).isVisible(),
    true,
  );
  await capture("narrow");
  await page.setViewportSize({ width: 1363, height: 1023 });
  assert.deepEqual(await app.store.get(owner.id), baseline);
  saveAllowed = true;
  await page.locator("#save").click();
  await page
    .locator("#saved-state")
    .getByText("✓ 已保存", { exact: true })
    .waitFor();
  saveAllowed = false;
  const saved = await app.store.get(owner.id);
  assert.deepEqual(saved.requests.find((r) => r.id === a.id).before, [
    { type: "wait", waitVersion: 1, milliseconds: 1250, enabled: false },
    { type: "wait", waitVersion: 1, milliseconds: 10000, enabled: true },
  ]);
  assert.deepEqual(saved.requests.find((r) => r.id === b.id).before, [
    variable,
  ]);
  assert.deepEqual(saved.history, baseline.history);
  assert.deepEqual(writes, ["PUT"]);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  console.log(
    "HTTP_PRE_WAIT_UI_PASS authored local wait order, ownership, explicit save and zero target dispatch",
  );
} finally {
  try {
    await browser?.close();
  } finally {
    await app?.close();
    await rm(home, { recursive: true, force: true });
  }
}
