import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";
import { normalizeProtocol } from "../src/protocol-definitions.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const storeRoot = await mkdtemp(join(tmpdir(), "selected-sse-workbench-"));
let app, browser;
try {
  app = await createApp({ root: storeRoot, port: 0 });
  const project = await app.store.create("默认项目");
  const local = "http://127.0.0.1:1/events";
  project.requests.push(
    normalizeRequest({
      id: "verification",
      name: "Verification",
      url: "http://127.0.0.1:1/verification",
    }),
  );
  for (const input of [
    {
      id: "sse-sample",
      name: "SSE调试示例",
      type: "sse",
      folder: "示例接口",
      url: local,
    },
    {
      id: "socket-fixture",
      name: "Socket fixture",
      type: "websocket",
      url: "ws://127.0.0.1:1/socket",
    },
    {
      id: "tcp-fixture",
      name: "TCP fixture",
      type: "tcp",
      url: "127.0.0.1",
      port: 1,
    },
  ])
    project.protocols.push(normalizeProtocol(input));
  await app.store.save(project);
  const before = await app.store.get(project.id);
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
  const errors = [],
    blocked = [],
    downloads = [],
    metrics = {};
  const origin = new URL(app.launchUrl).origin;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("download", (download) =>
    downloads.push(download.suggestedFilename()),
  );
  await page.addInitScript(() => localStorage.setItem("theme", "light"));
  await page.route("**/*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.origin === origin)
      return route.continue();
    blocked.push([request.method(), url.pathname]);
    return route.abort();
  });
  await page.goto(app.launchUrl);
  const row = (id) => page.locator(`[data-protocol-id="${id}"]`);
  const editor = page.locator(".selected-sse-workbench");
  const target = page.locator("#protocol-url");
  const type = page.locator("#protocol-type");
  const box = async (selector) => {
    const rect = await editor.locator(selector).boundingBox();
    assert.ok(rect, selector);
    return Object.fromEntries(
      Object.entries(rect).map(([key, value]) => [key, Math.round(value)]),
    );
  };
  const prefix = process.env.SSE_CAPTURE_PREFIX;
  const capture = async (narrow = false) => {
    if (!prefix) return;
    await page.mouse.move(800, 88);
    await page.screenshot({
      path: `${prefix}-${narrow ? "narrow" : "idle"}.png`,
      caret: "hide",
      ...(narrow ? {} : { clip: { x: 0, y: 0, width: 1363, height: 980 } }),
      animations: "disabled",
    });
  };
  await row("sse-sample").click();
  await editor.waitFor();
  assert.equal(await type.inputValue(), "sse");
  assert.equal(await target.inputValue(), local);
  assert.equal(
    await editor.locator("#protocol-name").inputValue(),
    "SSE调试示例",
  );
  assert.equal(await editor.locator("#session-status").innerText(), "未连接");
  assert.equal(await editor.getByText("尚无会话事件").isVisible(), true);
  assert.equal(await editor.locator("#protocol-port").isVisible(), false);
  for (const id of [
    "#protocol-run",
    "#cancel",
    "#save-protocol",
    "#session-connect",
    "#session-refresh",
    "#session-export",
  ])
    assert.equal(await editor.locator(id).isVisible(), true);
  assert.equal(await editor.locator("#session-send").isEnabled(), false);
  assert.equal(await editor.locator("#protocol-message").isVisible(), false);
  assert.equal(await editor.locator("#session-stop").isEnabled(), false);
  metrics.desktop = {
    urlFrame: await box(".sse-workbench-frame"),
    evidence: await box(".sse-workbench-evidence"),
  };
  console.log("SSE desktop geometry", JSON.stringify(metrics.desktop));
  await page.evaluate(() => document.activeElement?.blur());
  await capture();
  assert.deepEqual(
    [
      metrics.desktop.urlFrame.x,
      metrics.desktop.urlFrame.y,
      metrics.desktop.evidence.y,
    ],
    [371, 138, 583],
    JSON.stringify(metrics.desktop),
  );
  await target.press("Tab");
  assert.equal(
    await editor
      .locator("#protocol-run")
      .evaluate((node) => node === document.activeElement),
    true,
  );
  await target.fill("http://127.0.0.1:1/unsaved");
  await type.selectOption("tcp");
  assert.equal(await editor.locator("#protocol-port").isVisible(), true);
  assert.equal(await editor.locator("#protocol-message").isVisible(), true);
  assert.equal(await target.inputValue(), "http://127.0.0.1:1/unsaved");
  await type.selectOption("sse");
  assert.equal(await editor.locator("#protocol-port").isVisible(), false);
  for (const [id, value] of [
    ["socket-fixture", "websocket"],
    ["tcp-fixture", "tcp"],
  ]) {
    await row(id).click();
    assert.equal(await editor.count(), 0);
    assert.equal(await type.inputValue(), value);
    assert.equal(await page.locator("#protocol-port").isVisible(), true);
  }
  await row("sse-sample").click();
  assert.equal(await target.inputValue(), local);
  await page.setViewportSize({ width: 430, height: 900 });
  const narrowTarget = await box(".sse-workbench-target");
  const narrowEvidence = await box(".sse-workbench-evidence");
  metrics.narrow = { target: narrowTarget, evidence: narrowEvidence };
  for (const frame of [narrowTarget, narrowEvidence])
    assert(frame.x >= 0 && frame.x + frame.width <= 430, JSON.stringify(frame));
  assert.equal(
    await editor.evaluate((node) => node.scrollWidth <= node.clientWidth),
    true,
  );
  await editor.locator("#session-refresh").focus();
  assert.equal(
    await editor
      .locator("#session-refresh")
      .evaluate((node) => node === document.activeElement),
    true,
  );
  await editor.evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.evaluate(() => document.activeElement?.blur());
  await capture(true);
  assert.deepEqual(await app.store.get(project.id), before);
  assert.deepEqual(errors, []);
  assert.deepEqual(downloads, []);
  assert.deepEqual(blocked, []);
  if (prefix)
    await writeFile(
      prefix + ".json",
      JSON.stringify({ metrics, errors, downloads, blocked }, null, 2) + "\n",
    );
  console.log(
    "SSE_WORKBENCH_UI_PASS real-selected-idle/narrow/focus/alternate-protocols/no-write-or-connection",
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(storeRoot, { recursive: true, force: true });
}
