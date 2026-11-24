import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRequest } from "../src/core.mjs";
import { createApp } from "../src/server.mjs";
import { isMockTransportRoute } from "./helpers/mock-transport-route.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const root = await mkdtemp(join(tmpdir(), "workbench-url-query-"));
const raw = "https://fixture.invalid/items?tag=a%2Bb&tag=a+b&flag&empty=#part";
const edited = raw.replace("a%2Bb", "ui%2Bnext");
let browser, app;
try {
  app = await createApp({ root, port: 0 });
  const owner = await app.store.create("Literal Query fixture");
  owner.requests.push(
    normalizeRequest({
      id: "visual-query",
      name: "Verification",
      url: "https://fixture.invalid/items",
      query: [{ key: "explicit", value: "retained", enabled: true }],
    }),
    normalizeRequest({
      id: "opaque-query",
      name: "Imported",
      url: raw,
      sourceOperationId: "apipost:opaque",
    }),
  );
  await app.store.save(owner);
  const baseline = await app.store.get(owner.id);
  const origin = new URL(app.launchUrl).origin;
  const ownerPath = "/api/projects/" + owner.id;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    locale: "zh-CN",
    colorScheme: "light",
    deviceScaleFactor: 1,
  });
  page.setDefaultTimeout(6500);
  const writes = [],
    forbidden = [],
    errors = [];
  let allowSave = false;
  page.on("pageerror", ({ name }) => errors.push(name));
  await page.route("**/*", (route) => {
    const req = route.request();
    const dest = new URL(req.url());
    if (
      req.method() === "GET" &&
      dest.origin === origin &&
      !isMockTransportRoute(dest.pathname)
    )
      return route.continue();
    if (
      allowSave &&
      !writes.length &&
      req.method() === "PUT" &&
      dest.origin === origin &&
      dest.pathname === ownerPath
    ) {
      writes.push(req.method());
      return route.continue();
    }
    forbidden.push([req.method(), dest.origin === origin]);
    return route.abort();
  });
  await page.addInitScript(() => localStorage.setItem("theme", "light"));
  await page.goto(app.launchUrl);
  await page.locator('[data-mode="debug"]').click();
  const query = page.locator('.param-tabs [data-param="query"]');
  await query.press("Enter");
  const url = page.locator("#url");
  const group = page.locator(".debug-literal-query-origin");
  const table = group.getByRole("table", { name: "URL 中的查询" });
  const inputs = table.getByRole("textbox");
  const equality = group.getByRole("button", {
    name: "URL 空值等号",
    exact: true,
  });
  const tableEquality = page.locator("#query-add-equal");
  const first = table.getByRole("textbox", { name: "URL 查询值 1：tag" });
  const second = table.getByRole("textbox", { name: "URL 查询值 2：tag" });
  const values = () =>
    inputs.evaluateAll((nodes) => nodes.map((node) => node.value));
  const evidence = process.env.DEBUG_URL_QUERY_EVIDENCE;
  const capture = async (state) => {
    if (!evidence) return;
    await mkdir(evidence, { recursive: true });
    await page.screenshot({
      path: join(evidence, `debug-url-query-${state}.png`),
      caret: "hide",
      animations: "disabled",
    });
  };
  assert.equal(await group.isVisible(), false);
  await url.fill(raw);
  assert.deepEqual(await values(), ["a%2Bb", "a+b", "", ""]);
  assert.equal(await url.inputValue(), raw);
  assert.equal(await table.getByText("无等号", { exact: true }).count(), 1);
  assert.equal(
    await page.locator('[data-pair="query:0:value"]').inputValue(),
    "retained",
  );
  assert.match(await query.textContent(), /Query \(1\)/);
  await capture("duplicate-desktop");

  const editor = await first.elementHandle();
  await first.fill("ui%2Bnext");
  assert.equal(await url.inputValue(), edited);
  assert.deepEqual(await values(), ["ui%2Bnext", "a+b", "", ""]);
  assert.equal(
    await editor.evaluate(
      (node) =>
        node.isConnected &&
        node === document.activeElement &&
        node.selectionEnd === node.value.length,
    ),
    true,
  );
  await capture("edited-desktop");
  assert.equal(await equality.getAttribute("aria-pressed"), "mixed");
  assert.equal(await tableEquality.isChecked(), true);
  await equality.press("Enter");
  const allEqual = edited.replace("&flag&", "&flag=&");
  assert.equal(await equality.getAttribute("aria-pressed"), "true");
  assert.equal(await url.inputValue(), allEqual);
  await capture("blank-equality-keep-desktop");
  await equality.press("Space");
  const noEqual = edited.replace("&empty=", "&empty");
  assert.equal(await equality.getAttribute("aria-pressed"), "false");
  assert.equal(await url.inputValue(), noEqual);
  assert.equal(
    await equality.evaluate((node) => node === document.activeElement),
    true,
  );
  assert.equal(await editor.evaluate((node) => node.isConnected), true);
  assert.equal(await table.getByText("无等号", { exact: true }).count(), 2);
  assert.equal(await tableEquality.isChecked(), true);
  assert.deepEqual(await values(), ["ui%2Bnext", "a+b", "", ""]);
  assert.deepEqual(writes, []);
  await capture("blank-equality-omit-desktop");
  // Return to the previous mixed fixture for the existing lexical tests.
  await url.fill(edited);
  const sameOwnerEditor = await first.elementHandle();
  await first.fill("bad%2");
  assert.equal(await url.inputValue(), edited);
  assert.equal(await first.getAttribute("aria-invalid"), "true");
  await first.press("Control+s");
  await first.press("Escape");
  assert.equal(await first.inputValue(), "ui%2Bnext");
  assert.equal(await first.getAttribute("aria-invalid"), "false");
  const duringComposition = await second.evaluate((node) => {
    const previous = node.value;
    node.focus();
    node.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    node.value = "intermediate";
    node.dispatchEvent(
      new InputEvent("input", { bubbles: true, isComposing: true }),
    );
    const urlDuringComposition = document.querySelector("#url").value;
    node.value = previous;
    node.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    );
    return urlDuringComposition;
  });
  assert.equal(duringComposition, edited);
  assert.equal(await url.inputValue(), edited);
  await url.fill(edited.replace("tag=a+b", "tag=%2b"));
  assert.deepEqual(await values(), ["ui%2Bnext", "%2b", "", ""]);
  await sameOwnerEditor.evaluate((node) => {
    if (node.isConnected)
      throw Error("Expected detached editor after URL refresh");
    node.value = "not applicable";
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.deepEqual(await values(), ["ui%2Bnext", "%2b", "", ""]);
  await url.fill(edited);
  const beforeOwnerSwitch = await first.elementHandle();
  const staleEquality = await equality.elementHandle();
  await first.press("Control+Enter");
  assert.deepEqual(forbidden, []);
  assert.deepEqual(writes, []);

  await page.locator('.sidebar [data-request="opaque-query"]').click();
  assert.equal(await first.evaluate((node) => node.readOnly), true);
  assert.equal(await equality.count(), 0);
  await staleEquality.evaluate((node) => {
    if (node.isConnected) throw Error("Expected detached literal equality");
    node.click();
  });
  assert.equal(await url.inputValue(), raw);
  await beforeOwnerSwitch.evaluate((node) => {
    if (node.isConnected) throw Error("Expected detached literal editor");
    node.value = "never";
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.equal(await url.inputValue(), raw);
  await url.fill(raw.replace("a%2Bb", "{{template}}"));
  assert.equal(await table.count(), 0);
  assert.match(await group.textContent(), /无法安全拆分/);
  await url.fill(raw);
  await page.locator('.sidebar [data-request="visual-query"]').click();
  assert.deepEqual(await values(), ["ui%2Bnext", "a+b", "", ""]);
  assert.deepEqual(await app.store.get(owner.id), baseline);

  await page.setViewportSize({ width: 430, height: 830 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  await first.press("Tab");
  assert.equal(
    await second.evaluate((node) => node === document.activeElement),
    true,
  );
  await capture("edited-narrow");
  await equality.press("Space");
  await equality.press("Space");
  assert.equal(await url.inputValue(), noEqual);
  assert.equal(await equality.getAttribute("aria-pressed"), "false");
  assert.equal(await tableEquality.isChecked(), true);
  await capture("blank-equality-omit-narrow");
  await page.setViewportSize({ width: 1363, height: 1023 });
  allowSave = true;
  await page.locator("#save").click();
  await page
    .locator("#saved-state")
    .getByText("✓ 已保存", { exact: true })
    .waitFor();
  allowSave = false;
  const saved = await app.store.get(owner.id);
  assert.equal(saved.requests[0].url, noEqual);
  assert.deepEqual(saved.requests[0].query, baseline.requests[0].query);
  assert.equal(
    saved.requests[0].queryAddEqual,
    baseline.requests[0].queryAddEqual,
  );
  assert.deepEqual(saved.requests[1], baseline.requests[1]);
  assert.deepEqual(saved.history, baseline.history);
  assert.deepEqual(writes, ["PUT"]);
  assert.deepEqual(forbidden, []);
  assert.deepEqual(errors, []);
  console.log(
    "DEBUG_URL_QUERY_UI_PASS literal occurrence edits preserve raw neighbors, no dispatch",
  );
} finally {
  try {
    await browser?.close();
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
}
