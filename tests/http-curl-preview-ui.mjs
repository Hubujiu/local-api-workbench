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
const root = await mkdtemp(join(tmpdir(), "workbench-curl-preview-"));
const evidence = process.env.HTTP_CURL_PREVIEW_EVIDENCE;
let app, browser;
try {
  app = await createApp({ root, port: 0 });
  const definition = (id, name, path) =>
    normalizeRequest({
      id,
      name,
      url: "https://fixture.invalid" + path,
      method: "GET",
      auth: { type: "none" },
    });
  const a = await app.store.create("Preview A");
  a.requests = [
    definition("same", "First request", "/first?tag=a%2Bb&tag=a+b"),
    definition("other", "Other request", "/other"),
  ];
  await app.store.save(a);
  const b = await app.store.create("Preview B");
  b.requests = [definition("same", "Different project", "/different-project")];
  await app.store.save(b);
  const snapshots = await Promise.all([
    app.store.get(a.id),
    app.store.get(b.id),
  ]);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
    locale: "zh-CN",
  });
  page.setDefaultTimeout(6500);
  await page.addInitScript((id) => {
    sessionStorage.setItem("project", id);
    localStorage.setItem("theme", "light");
    window.explicitCopies = [];
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (value) => window.explicitCopies.push(value) },
    });
  }, a.id);
  const origin = new URL(app.launchUrl).origin;
  const errors = [],
    blocked = [],
    compiles = [];
  let captureNext;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const request = route.request();
    const destination = new URL(request.url());
    if (destination.origin === origin && request.method() === "GET")
      return route.continue();
    if (
      destination.origin === origin &&
      request.method() === "POST" &&
      [a.id, b.id].some(
        (id) => destination.pathname === "/api/projects/" + id + "/curl",
      )
    ) {
      const waiter = captureNext;
      captureNext = undefined;
      compiles.push(request.postDataJSON());
      const upstream = await route.fetch();
      const receipt = await upstream.json();
      if (!waiter) return route.fulfill({ response: upstream });
      await new Promise((release) =>
        waiter({
          receipt,
          async resume() {
            release();
          },
        }),
      );
      return route.fulfill({ response: upstream });
    }
    blocked.push([request.method(), destination.pathname]);
    return route.abort();
  });
  await page.goto(app.launchUrl);
  const editor = page.locator('.editor[data-editor-mode="debug"]');
  const pick = async (id) => {
    await page.locator(`.sidebar [data-request="${id}"]`).click();
    if (!(await editor.count()))
      await page.locator('[data-mode="debug"]').click();
    await editor.waitFor();
  };
  const drawer = page.getByRole("dialog", { name: "生成代码", exact: true });
  const opener = page.getByRole("button", { name: "生成 cURL", exact: true });
  const close = drawer.getByRole("button", { name: "关闭", exact: true });
  const copy = drawer.getByRole("button", { name: "复制代码", exact: true });
  const output = drawer.getByRole("textbox", { name: "生成的 cURL 代码" });
  const loading = drawer.getByText("生成中...", { exact: true });
  const active = (target) =>
    target.evaluate((element) => element === document.activeElement);
  const capture = async (name) => {
    if (!evidence) return;
    await mkdir(evidence, { recursive: true });
    await page.screenshot({
      path: join(evidence, `http-curl-preview-${name}.png`),
      animations: "disabled",
    });
  };
  const hold = () => new Promise((resolve) => (captureNext = resolve));
  const release = async (pending) => {
    const done = page.waitForEvent("requestfinished", {
      predicate: (request) =>
        request.method() === "POST" && request.url().endsWith("/curl"),
    });
    await pending.resume();
    await done;
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
  };
  await pick("same");
  const first = hold();
  await opener.click();
  await loading.waitFor();
  assert.equal(await copy.isDisabled(), true);
  assert.equal(await output.count(), 0);
  assert.equal(await active(close), true);
  const before = await first;
  await capture("loading-desktop");
  await release(before);
  await output.waitFor();
  assert.equal(await output.inputValue(), before.receipt.curl);
  assert.equal(await output.getAttribute("readonly"), "");
  assert.match(await output.inputValue(), /tag=a%2Bb&tag=a\+b/);
  assert.deepEqual(await page.evaluate(() => window.explicitCopies), []);
  const geometry = await page.evaluate(() => {
    const box = (node) => {
      const { x, y, width, height } = document
        .querySelector(node)
        .getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      drawer: box("#curl-preview-dialog"),
      header: box(".curl-preview-header"),
      rail: box(".curl-preview-rail"),
      gutter: box(".curl-preview-gutter"),
      output: box("#curl-output"),
    };
  });
  console.log("HTTP_CURL_PREVIEW_GEOMETRY", JSON.stringify(geometry));
  assert.deepEqual(geometry.drawer, { x: 503, y: 0, width: 860, height: 1023 });
  assert.equal(geometry.header.height, 50);
  assert.equal(geometry.rail.width, 211);
  assert.equal(geometry.gutter.width, 61);
  assert.equal(geometry.output.x, 775);
  await capture("ready-desktop");
  await page.keyboard.press("Control+Enter");
  await page.keyboard.press("Control+s");
  await close.press("Escape");
  await drawer.waitFor({ state: "hidden" });
  assert.equal(await active(opener), true);
  assert.equal(
    await page.locator("#url").inputValue(),
    "https://fixture.invalid/first?tag=a%2Bb&tag=a+b",
  );

  const stale = hold();
  await opener.click();
  const late = await stale;
  await close.click();
  assert.equal(await active(opener), true);
  await pick("other");
  const newCall = hold();
  await opener.click();
  const current = await newCall;
  await release(late);
  assert.equal(await loading.isVisible(), true);
  assert.equal(await copy.isDisabled(), true);
  await release(current);
  await output.waitFor();
  assert.match(await output.inputValue(), /\/other/);
  assert.doesNotMatch(await output.inputValue(), /\/first/);
  await close.click();

  const oldProject = hold();
  await opener.click();
  const oldProjectReceipt = await oldProject;
  await close.press("Escape");
  await page.locator("#project-select").selectOption(b.id);
  await page.waitForFunction(
    (id) =>
      document.querySelector("#project-select option[selected]")?.value === id,
    b.id,
  );
  await pick("same");
  await release(oldProjectReceipt);
  assert.equal(await drawer.count(), 0);
  assert.equal(
    await page.locator("#request-name").inputValue(),
    "Different project",
  );

  await page.setViewportSize({ width: 430, height: 830 });
  const narrow = hold();
  await opener.click();
  const narrowResult = await narrow;
  await loading.waitFor();
  await capture("loading-narrow");
  await release(narrowResult);
  await output.waitFor();
  assert.equal((await drawer.boundingBox()).width, 430);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  assert.equal(await copy.isEnabled(), true);
  await capture("ready-narrow");
  await copy.press("Enter");
  await drawer.waitFor({ state: "hidden" });
  assert.deepEqual(await page.evaluate(() => window.explicitCopies), [
    narrowResult.receipt.curl,
  ]);
  assert.equal(await active(opener), true);
  assert.equal(compiles.length, 5);
  assert.deepEqual(
    await Promise.all([app.store.get(a.id), app.store.get(b.id)]),
    snapshots,
  );
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  console.log(
    "HTTP_CURL_PREVIEW_UI_PASS real local compiles, nothing sent/executed or written, exact output and owned reopen",
  );
} finally {
  try {
    await browser?.close();
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
}
