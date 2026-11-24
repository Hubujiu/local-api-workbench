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
// Report only enums, counts, and fixture comparisons; never URLs or raw receipts.
function saveFacts(payload, expectedURL, expectedDisabled) {
  const req = payload?.requests?.find(({ id }) => id === "visual-query");
  const entries = payload?.literalQueryEditor?.entries;
  const entry = entries?.find(({ requestId }) => requestId === "visual-query");
  return {
    canonicalMatches: req?.url === expectedURL,
    configRevision: payload?.configRevision,
    entries: entries?.length ?? 0,
    disabled: entry?.rows.filter(({ enabled }) => !enabled).length ?? 0,
    entryMatches: expectedDisabled
      ? entry?.effectiveURL === expectedURL
      : !entry,
  };
}

async function pressOwnerSave(
  page,
  origin,
  path,
  phase,
  expectedURL,
  expectedDisabled,
) {
  const state = page.locator("#saved-state");
  const isOwnerSave = (req) => {
    const dest = new URL(req.url());
    return (
      req.method() === "PUT" && dest.origin === origin && dest.pathname === path
    );
  };
  const diagnostic = { phase, request: null, response: null };
  const observeRequest = (req) => {
    if (!isOwnerSave(req)) return;
    try {
      diagnostic.request = saveFacts(
        req.postDataJSON(),
        expectedURL,
        expectedDisabled,
      );
    } catch {
      diagnostic.request = "unreadable";
    }
  };
  page.on("request", observeRequest);
  try {
    assert.equal(await state.textContent(), "● 未保存");
    const [response] = await Promise.all([
      page.waitForResponse((response) => isOwnerSave(response.request())),
      page.locator("#save").click(),
    ]);
    diagnostic.response = { status: response.status() };
    const receipt = await response.json().catch(() => null);
    if (response.ok()) {
      diagnostic.response.receipt = saveFacts(
        receipt,
        expectedURL,
        expectedDisabled,
      );
    } else {
      diagnostic.response.notCommitted =
        receipt?.commit_outcome === "not_committed";
      diagnostic.response.retrySafe = receipt?.retry_safe === true;
      diagnostic.response.literalQueryValidation =
        typeof receipt?.error === "string" &&
        receipt.error.includes("URL 查询编辑状态");
    }
    assert.equal(response.status(), 200, "Owner PUT must commit successfully");
    await state.getByText("✓ 已保存", { exact: true }).waitFor();
  } catch (error) {
    diagnostic.ui = await page
      .evaluate(() => {
        const state = document.querySelector("#saved-state")?.textContent;
        const toast = document.querySelector("#toast")?.textContent || "";
        return {
          saveDisabled: document.querySelector("#save")?.disabled,
          saved: state === "✓ 已保存",
          dirty: state === "● 未保存",
          unconfirmed: toast.includes("保存结果尚未确认"),
          newerDraft: toast.includes("已保存本次快照"),
          literalQueryValidation: toast.includes("URL 查询编辑状态"),
        };
      })
      .catch(() => null);
    console.error(
      "DEBUG_URL_QUERY_SAVE_DIAGNOSTICS",
      JSON.stringify(diagnostic),
    );
    throw error;
  } finally {
    page.off("request", observeRequest);
  }
}
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
  const duplicateEnabled = table.getByRole("checkbox", {
    name: "启用 URL 查询项 2：tag",
  });
  const selectAll = table.getByRole("checkbox", {
    name: "启用全部 URL 查询项",
  });
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
    await duplicateEnabled.evaluate((node) => node === document.activeElement),
    true,
  );
  await duplicateEnabled.press("Tab");
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
  const withoutDuplicate = noEqual.replace("&tag=a+b", "");
  await duplicateEnabled.press("Space");
  assert.equal(await duplicateEnabled.isChecked(), false);
  assert.equal(
    await duplicateEnabled.evaluate((node) => node === document.activeElement),
    true,
  );
  assert.equal(await selectAll.evaluate((node) => node.indeterminate), true);
  assert.equal(await url.inputValue(), withoutDuplicate);
  assert.equal(await second.inputValue(), "a+b");
  assert.equal(await second.evaluate((node) => node.readOnly), true);
  await capture("unchecked-narrow");
  await page.setViewportSize({ width: 1363, height: 1023 });
  await capture("unchecked-desktop");

  // All-off stays a visible local editor and never moves a query past the fragment.
  await selectAll.press("Space");
  assert.equal(await selectAll.isChecked(), true);
  assert.equal(await url.inputValue(), noEqual);
  await selectAll.press("Space");
  assert.equal(await url.inputValue(), "https://fixture.invalid/items#part");
  assert.equal(await inputs.count(), 4);
  assert.equal(await selectAll.isChecked(), false);
  await selectAll.press("Space");
  assert.equal(await url.inputValue(), noEqual);
  await duplicateEnabled.press("Space");
  assert.equal(await url.inputValue(), withoutDuplicate);
  await url.fill("https://fixture.invalid/items?other=1#part");
  assert.equal(await duplicateEnabled.count(), 0);
  await url.fill(noEqual);
  assert.equal(await duplicateEnabled.isChecked(), true);
  await duplicateEnabled.press("Space");
  assert.equal(await url.inputValue(), withoutDuplicate);
  assert.deepEqual(writes, []);
  assert.deepEqual(await app.store.get(owner.id), baseline);
  allowSave = true;
  await pressOwnerSave(
    page,
    origin,
    ownerPath,
    "disable",
    withoutDuplicate,
    true,
  );
  allowSave = false;
  const saved = await app.store.get(owner.id);
  assert.equal(saved.requests[0].url, withoutDuplicate);
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
  assert.deepEqual(saved.literalQueryEditor.entries[0].rows, [
    { token: "tag=ui%2Bnext", enabled: true },
    { token: "tag=a+b", enabled: false },
    { token: "flag", enabled: true },
    { token: "empty", enabled: true },
  ]);
  await page.close();
  await app.close();
  app = await createApp({ root, port: 0 });
  const reopened = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    locale: "zh-CN",
  });
  const restartOrigin = new URL(app.launchUrl).origin;
  const restartWrites = [];
  const restartForbidden = [];
  const restartErrors = [];
  let allowRestartSave = false;
  reopened.on("pageerror", ({ name }) => restartErrors.push(name));
  await reopened.route("**/*", (route) => {
    const req = route.request();
    const dest = new URL(req.url());
    if (
      req.method() === "GET" &&
      dest.origin === restartOrigin &&
      !isMockTransportRoute(dest.pathname)
    )
      return route.continue();
    if (
      allowRestartSave &&
      restartWrites.length === 0 &&
      req.method() === "PUT" &&
      dest.origin === restartOrigin &&
      dest.pathname === ownerPath
    ) {
      restartWrites.push(req.method());
      return route.continue();
    }
    restartForbidden.push(req.method());
    return route.abort();
  });
  await reopened.goto(app.launchUrl);
  await reopened.locator('[data-mode="debug"]').click();
  await reopened.locator('.param-tabs [data-param="query"]').press("Enter");
  const retained = reopened.getByRole("checkbox", {
    name: "启用 URL 查询项 2：tag",
  });
  assert.equal(await retained.isChecked(), false);
  assert.equal(await reopened.locator("#url").inputValue(), withoutDuplicate);
  assert.equal(
    await reopened
      .getByRole("textbox", { name: "URL 查询值 2：tag" })
      .inputValue(),
    "a+b",
  );
  if (evidence)
    await reopened.screenshot({
      path: join(evidence, "debug-url-query-unchecked-restarted.png"),
      caret: "hide",
      animations: "disabled",
    });
  await retained.press("Space");
  assert.equal(await reopened.locator("#url").inputValue(), noEqual);
  assert.equal(await retained.isChecked(), true);
  if (evidence)
    await reopened.screenshot({
      path: join(evidence, "debug-url-query-restored-restarted.png"),
      caret: "hide",
      animations: "disabled",
    });
  assert.deepEqual(restartWrites, []);
  assert.equal(
    (await app.store.get(owner.id)).requests[0].url,
    withoutDuplicate,
  );
  allowRestartSave = true;
  await pressOwnerSave(
    reopened,
    restartOrigin,
    ownerPath,
    "restore",
    noEqual,
    false,
  );
  allowRestartSave = false;
  const final = await app.store.get(owner.id);
  assert.equal(final.requests[0].url, noEqual);
  assert.equal(final.literalQueryEditor, undefined);
  assert.deepEqual(final.requests[0].query, baseline.requests[0].query);
  assert.deepEqual(final.history, baseline.history);
  assert.deepEqual(restartWrites, ["PUT"]);
  assert.deepEqual(restartForbidden, []);
  assert.deepEqual(restartErrors, []);
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
