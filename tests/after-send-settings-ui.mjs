import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const evidence = process.env.AFTER_SEND_SETTINGS_EVIDENCE;
const root = await mkdtemp(join(tmpdir(), "workbench-after-send-"));
const app = await createApp({ root, port: 0 });
let browser;
try {
  let owner = await app.store.create("默认项目");
  owner.requests = [
    normalizeRequest({
      id: "fixture",
      name: "Verification",
      method: "GET",
      url: "http://127.0.0.1:38982/never-sent",
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
    errors = [],
    sends = [];
  const execute = "/api/projects/" + owner.id + "/execute";
  let pending;
  page.on("pageerror", () => errors.push("unexpected page error"));
  await page.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (
      url.origin === origin &&
      req.method() === "GET" &&
      url.pathname !== "/mcp"
    )
      return route.continue();
    if (
      url.origin === origin &&
      req.method() === "POST" &&
      url.pathname === execute &&
      pending
    ) {
      const ticket = pending;
      pending = null;
      const input = req.postDataJSON();
      sends.push(input.request.id);
      assert.equal(input.request.url, "http://127.0.0.1:38982/never-sent");
      ticket.started();
      await ticket.go;
      // Synthetic UI receipt only; this route never reaches the transport/runtime.
      return route.fulfill(
        ticket.failed
          ? { status: 502, json: { error: "synthetic connection failure" } }
          : {
              json: {
                status: 201,
                body: '{"synthetic":"local fixture"}',
                headers: { "x-local-fixture": "true" },
                duration: 1,
                size: 2,
              },
            },
      );
    }
    blocked.push(req.method());
    return route.abort();
  });
  const owned = () =>
    page.waitForFunction(
      (id) =>
        document.querySelector("#project-select option[selected]")?.value ===
        id,
      owner.id,
    );
  await page.goto(app.launchUrl);
  await owned();
  const open = page.locator("#appearance-settings");
  const modal = page.getByRole("dialog", { name: "应用设置", exact: true });
  const settingsTab = modal.getByRole("tab", {
    name: "发送后设置",
    exact: true,
  });
  const panel = modal.getByRole("tabpanel", {
    name: "发送后设置",
    exact: true,
  });
  const toggle = panel.getByRole("switch", {
    name: "发送后切换到实时响应",
    exact: true,
  });
  const reset = modal.getByRole("button", {
    name: "恢复默认发送后设置",
    exact: true,
  });
  const focus = (locator) =>
    locator.evaluate((node) => node === document.activeElement);
  const openSettings = async () => {
    await open.press("Enter");
    await modal
      .getByRole("tab", { name: "外观", exact: true })
      .press("ArrowDown");
    await modal
      .getByRole("tab", { name: "发送设置", exact: true })
      .press("ArrowDown");
    await panel.waitFor();
    assert(await focus(settingsTab));
  };
  const closeSettings = async () => {
    await page.keyboard.press("Escape");
    await modal.waitFor({ state: "hidden" });
    assert(await focus(open));
  };
  const capture = async (name, narrow = false) => {
    if (!evidence) return;
    await mkdir(evidence, { recursive: true });
    await page.screenshot({
      path: join(evidence, "after-send-settings-" + name + ".png"),
      ...(narrow ? {} : { clip: { x: 224, y: 192, width: 916, height: 643 } }),
      caret: "hide",
    });
  };
  await openSettings();
  assert(!(await toggle.isChecked()));
  assert(await reset.isDisabled());
  const frame = await modal.boundingBox(),
    pill = await toggle.boundingBox();
  console.log("AFTER_SEND_SETTINGS_GEOMETRY", JSON.stringify({ frame, pill }));
  assert.deepEqual(
    [frame.x, frame.y, frame.width, frame.height].map(Math.round),
    [242, 212, 880, 600],
  );
  assert(Math.abs(pill.x - 1051) <= 1);
  assert.deepEqual([pill.width, pill.height].map(Math.round), [40, 20]);
  await capture("off");
  await closeSettings();

  const name = page.locator("#request-name"),
    send = page.locator("#send");
  const body = page.locator('[data-response="body"]'),
    headers = page.locator('[data-response="headers"]'),
    cookies = page.locator('[data-response="cookies"]');
  const selected = async (view) =>
    assert.equal(await view.getAttribute("aria-pressed"), "true");
  const sendWith = async (midFlight, failed = false) => {
    let started, release, timer;
    const admitted = new Promise((resolve) => (started = resolve));
    const go = new Promise((resolve) => (release = resolve));
    pending = { started, go, failed };
    try {
      await send.press("Enter");
      await Promise.race([
        admitted,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error("manual send was not admitted")),
            8000,
          );
        }),
      ]);
      if (midFlight) await midFlight();
    } finally {
      clearTimeout(timer);
      release();
    }
    await page.locator("#send:not([disabled])").waitFor();
  };
  await headers.press("Enter");
  await sendWith();
  await selected(headers);
  await openSettings();
  await toggle.press("Space");
  assert(await toggle.isChecked());
  assert(!(await reset.isDisabled()));
  await closeSettings();
  await page.reload();
  await owned();
  await openSettings();
  assert(await toggle.isChecked());
  await closeSettings();
  await name.fill("Owned unsaved Debug draft");
  await headers.press("Enter");
  await sendWith();
  await selected(body);
  await page.getByText(/"synthetic": "local fixture"/).waitFor();
  await headers.press("Enter");
  await sendWith(() => cookies.press("Enter"));
  await selected(cookies);
  await headers.press("Enter");
  await sendWith(async () => {
    await page.locator('.rail [data-page="history"]').press("Enter");
    await page.locator('.rail [data-page="apis"]').press("Enter");
  });
  await selected(headers);
  await sendWith(undefined, true);
  await selected(headers);
  await page.setViewportSize({ width: 430, height: 760 });
  await openSettings();
  const narrow = await modal.boundingBox();
  assert(narrow.x >= 0 && narrow.x + narrow.width <= 430);
  await capture("on-narrow", true);
  await reset.press("Enter");
  assert(!(await toggle.isChecked()));
  assert(await focus(toggle));
  assert.equal(
    await page.evaluate(() => localStorage.getItem("after-send-open-response")),
    null,
  );
  await closeSettings();
  assert.equal(await name.inputValue(), "Owned unsaved Debug draft");
  assert.deepEqual(sends, Array(5).fill("fixture"));
  const persisted = await app.store.get(owner.id);
  assert.equal(persisted.configRevision, owner.configRevision);
  assert.deepEqual(persisted.history, []);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  console.log(
    "AFTER_SEND_SETTINGS_UI_PASS opt-in/reset/1363+430/authored-synthetic-response/owner/choice/failure/no-runtime/no-writes",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
