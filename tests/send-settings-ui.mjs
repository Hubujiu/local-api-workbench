import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";
import { chooseProjectSwitch } from "./helpers/project-switch-confirmation-ui.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const evidence = process.env.SEND_SETTINGS_EVIDENCE;
const root = await mkdtemp(join(tmpdir(), "workbench-send-settings-"));
const app = await createApp({ root, port: 0 });
let browser;
try {
  let original = await app.store.create("默认项目");
  original.requests = [
    normalizeRequest({
      id: "existing",
      name: "Verification",
      url: "http://127.0.0.1:38982/no-send",
      timeout: 12345,
    }),
  ];
  original = await app.store.save(original);
  const empty = await app.store.create("合成空项目");
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
  await page.addInitScript(
    (id) => sessionStorage.setItem("project", id),
    original.id,
  );
  page.on("pageerror", () => errors.push("unexpected page error"));
  await page.route("**/*", (route) => {
    const req = route.request(),
      u = new URL(req.url());
    if (u.origin === origin && req.method() === "GET" && u.pathname !== "/mcp")
      return route.continue();
    blocked.push(req.method());
    return route.abort();
  });
  const adopt = (id) =>
    page.waitForFunction(
      (expected) =>
        document.querySelector("#project-select option[selected]")?.value ===
        expected,
      id,
    );
  await page.goto(app.launchUrl);
  await adopt(original.id);
  const open = page.locator("#appearance-settings");
  const modal = page.getByRole("dialog", { name: "应用设置", exact: true });
  const tab = modal.getByRole("tab", { name: "发送设置", exact: true });
  const panel = modal.getByRole("tabpanel", { name: "发送设置", exact: true });
  const timeout = panel.getByRole("spinbutton", {
    name: "新建 HTTP 接口的默认超时",
    exact: true,
  });
  const reset = modal.getByRole("button", {
    name: "恢复默认超时",
    exact: true,
  });
  const error = panel.getByRole("status");
  const focused = (locator) =>
    locator.evaluate((node) => document.activeElement === node);
  const openTimeout = async () => {
    await open.press("Enter");
    await modal
      .getByRole("tab", { name: "外观", exact: true })
      .press("ArrowDown");
    await panel.waitFor();
    assert(await focused(tab));
  };
  const close = async () => {
    await page.keyboard.press("Escape");
    await modal.waitFor({ state: "hidden" });
    assert(await focused(open));
  };
  const capture = async (label, narrow = false) => {
    if (!evidence) return;
    await mkdir(evidence, { recursive: true });
    await page.screenshot({
      path: join(evidence, "send-timeout-" + label + ".png"),
      ...(narrow ? {} : { clip: { x: 224, y: 192, width: 916, height: 643 } }),
      caret: "hide",
    });
  };
  const value = () =>
    page.evaluate(() => localStorage.getItem("new-http-request-timeout-ms"));
  await openTimeout();
  assert.equal(await timeout.inputValue(), "15000");
  assert(await reset.isDisabled());
  const frame = await modal.boundingBox(),
    input = await timeout.boundingBox();
  console.log(
    "SEND_SETTINGS_TIMEOUT_GEOMETRY",
    JSON.stringify({ frame, input }),
  );
  assert.deepEqual(
    [frame.x, frame.y, frame.width, frame.height].map(Math.round),
    [242, 212, 880, 600],
  );
  assert.deepEqual([input.width, input.height].map(Math.round), [109, 32]);
  assert(Math.abs(input.x - 983) <= 1);
  assert(Math.abs(input.y - 293) <= 1);
  await capture("default");
  await timeout.fill("60001");
  await timeout.press("Enter");
  assert.equal(await timeout.getAttribute("aria-invalid"), "true");
  assert.match(await error.textContent(), /100–60000/);
  assert.equal(await value(), null);
  await timeout.fill("23456");
  await timeout.press("Enter");
  assert.equal(await value(), "23456");
  await close();
  await page.reload();
  await adopt(original.id);
  await openTimeout();
  assert.equal(await timeout.inputValue(), "23456");
  await close();
  const checkDesignTimeout = async (expected) => {
    await page.locator('[data-mode="design"]').press("Enter");
    assert.equal(await page.locator("#timeout").inputValue(), String(expected));
  };
  await checkDesignTimeout(12345);
  await page.locator("#add-request").press("Enter");
  await checkDesignTimeout(23456);
  await page.locator(".tree-create > summary").press("Enter");
  await page.locator("#new-request").press("Enter");
  await checkDesignTimeout(23456);
  await page.locator("#tab-add").press("Enter");
  await checkDesignTimeout(23456);
  await chooseProjectSwitch(page, "discard", () =>
    page.locator("#project-select").selectOption(empty.id),
  );
  await adopt(empty.id);
  await page.locator("#welcome-add").press("Enter");
  await checkDesignTimeout(23456);
  await page.setViewportSize({ width: 430, height: 760 });
  await openTimeout();
  const narrow = await modal.boundingBox();
  assert(narrow.x >= 0 && narrow.x + narrow.width <= 430);
  await capture("narrow", true);
  await reset.press("Enter");
  assert(await focused(timeout));
  assert.equal(await timeout.inputValue(), "15000");
  assert.equal(await value(), null);
  await close();
  await checkDesignTimeout(23456);
  await page.locator("#tab-add").press("Enter");
  await checkDesignTimeout(15000);
  assert.equal(await page.locator("#saved-state").textContent(), "● 未保存");
  assert.equal((await app.store.get(original.id)).requests[0].timeout, 12345);
  assert.deepEqual((await app.store.get(empty.id)).requests, []);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  console.log(
    "SEND_SETTINGS_TIMEOUT_UI_PASS all-new-http-entrypoints/validation/persistence/reset/1363+430/only-drafts/no-writes-or-sends",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
