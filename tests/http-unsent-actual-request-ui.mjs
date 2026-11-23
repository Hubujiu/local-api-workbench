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
const root = await mkdtemp(join(tmpdir(), "workbench-actual-request-unsent-"));
const url = "http://127.0.0.1:1/syntheticNotSent";
const privateDraftFields = [
  "syntheticNotSent",
  "X-Unsent-Synthetic",
  "noQueryValue",
  "noBodyValue",
];
let app, browser;
try {
  app = await createApp({ root, port: 0 });
  const owner = await app.store.create("未发送实际请求");
  owner.requests = [
    normalizeRequest({
      id: "verification",
      name: "Verification",
      url,
      method: "GET",
      headers: [{ key: "X-Unsent-Synthetic", value: "not delivered" }],
      query: [{ key: "query", value: "noQueryValue" }],
      bodyType: "none",
    }),
    normalizeRequest({
      id: "independent",
      name: "Independent",
      url,
      method: "POST",
      bodyType: "raw",
      body: "noBodyValue",
    }),
  ];
  await app.store.save(owner);
  const other = await app.store.create("项目隔离");
  other.requests = [
    normalizeRequest({ id: "verification", name: "Other", url, method: "PUT" }),
  ];
  await app.store.save(other);
  const baselines = await Promise.all([
    app.store.get(owner.id),
    app.store.get(other.id),
  ]);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
    locale: "zh-CN",
    colorScheme: "light",
  });
  page.setDefaultTimeout(6500);
  await page.addInitScript((id) => {
    sessionStorage.setItem("project", id);
    localStorage.setItem("theme", "light");
    localStorage.setItem("response-layout", "stacked");
  }, owner.id);
  const blocked = [],
    errors = [];
  const origin = new URL(app.launchUrl).origin;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const request = route.request();
    const destination = new URL(request.url());
    if (request.method() === "GET" && destination.origin === origin)
      return route.continue();
    blocked.push([request.method(), destination.pathname]);
    return route.abort();
  });
  await page.goto(app.launchUrl);
  const editor = page.locator('.editor[data-editor-mode="debug"]');
  const response = editor.locator(".response");
  const responseTab = (name) => response.locator(`[data-response="${name}"]`);
  const region = response.getByRole("region", {
    name: "实际请求（未发送）",
    exact: true,
  });
  const tab = (name) => region.getByRole("tab", { name, exact: true });
  const panel = (name) => region.getByRole("tabpanel", { name, exact: true });
  const pick = async (id) =>
    page.locator(`#tree [data-request="${id}"]`).click();
  const open = async () => {
    await responseTab("request").press("Enter");
    await region.waitFor();
    assert.equal(
      await responseTab("request").getAttribute("aria-pressed"),
      "true",
    );
  };
  const selected = async (name, emptyText) => {
    assert.equal(await tab(name).getAttribute("aria-selected"), "true");
    assert.equal(await tab(name).getAttribute("tabindex"), "0");
    assert.equal(await region.locator('[role="tab"][tabindex="0"]').count(), 1);
    assert.equal(await region.getByRole("tabpanel").count(), 1);
    assert.equal(
      await panel(name).getByText(emptyText, { exact: true }).isVisible(),
      true,
    );
    assert.equal(await response.locator(".metrics > span").count(), 0);
    const text = await region.textContent();
    for (const field of privateDraftFields) assert(!text.includes(field));
  };
  const active = (el) => el.evaluate((node) => node === document.activeElement);
  const evidence = process.env.HTTP_UNSENT_ACTUAL_REQUEST_EVIDENCE;
  const capture = async (name) => {
    if (!evidence) return;
    await mkdir(evidence, { recursive: true });
    await page.mouse.move(8, 85);
    await page.screenshot({
      path: join(evidence, `http-unsent-actual-request-${name}.png`),
      caret: "hide",
      animations: "disabled",
    });
  };

  await pick("verification");
  await editor.locator('[data-param="body"]').press("Enter");
  await editor.locator(".body-none").waitFor();
  assert.equal(await editor.locator("#url").inputValue(), url);
  await open();
  assert.equal(await region.locator(".method").textContent(), "GET");
  assert.equal(
    await region.getByText("未发送", { exact: true }).isVisible(),
    true,
  );
  assert.deepEqual(await region.getByRole("tab").allTextContents(), [
    "Header",
    "Query",
    "Path",
    "Body",
  ]);
  await selected("Header", "未定义请求头");
  const geometry = await region.evaluate((node) => {
    const rect = (selector) => {
      const { x, y, width, height } = node
        .querySelector(selector)
        .getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      url: rect("h3"),
      method: rect(".method"),
      requestParameters: rect("h3:nth-of-type(2)"),
      tabs: rect('[role="tablist"]'),
      panel: rect('[role="tabpanel"]:not([hidden])'),
    };
  });
  console.log("HTTP_UNSENT_ACTUAL_REQUEST_GEOMETRY", JSON.stringify(geometry));
  await capture("header-desktop");
  const near = (actual, target, slack) =>
    assert(
      Math.abs(actual - target) <= slack,
      JSON.stringify({ actual, target, geometry }),
    );
  near(geometry.url.x, 371, 2);
  near(geometry.panel.width, 976, 3);
  near(geometry.panel.y, 803, 8);
  await responseTab("extracted").press("Tab");
  assert.equal(await active(tab("Header")), true);
  await tab("Header").press("ArrowRight");
  assert.equal(await active(tab("Query")), true);
  await selected("Query", "未定义 URL 参数");
  await capture("query-desktop");
  await tab("Query").press("ArrowRight");
  await selected("Path", "未定义路径参数");
  await capture("path-desktop");
  const stale = await tab("Header").elementHandle();
  await tab("Path").press("End");
  await selected("Body", "未定义请求体");
  assert.equal(
    await panel("Body").getByText("类型:", { exact: true }).isVisible(),
    true,
  );
  await capture("body-desktop");
  await tab("Body").press("ArrowRight");
  await selected("Header", "未定义请求头");
  await tab("Header").press("ArrowLeft");
  await selected("Body", "未定义请求体");
  await tab("Body").press("Tab");
  assert.equal(await active(panel("Body")), true);

  await pick("independent");
  await open();
  await selected("Header", "未定义请求头");
  assert.equal(await region.locator(".method").textContent(), "POST");
  await stale.evaluate((node) => {
    assertDetached(node);
    function assertDetached(item) {
      if (item.isConnected) throw Error("Expected detached stale tab");
      item.click();
    }
  });
  await selected("Header", "未定义请求头");
  await pick("verification");
  await open();
  await selected("Body", "未定义请求体");

  await tab("Body").press("Home");
  await page.setViewportSize({ width: 430, height: 830 });
  await page.locator("#theme").press("Enter");
  assert.equal(
    await page.evaluate(() => document.body.classList.contains("dark")),
    true,
  );
  await responseTab("body").press("Enter");
  await open();
  await selected("Header", "未定义请求头");
  const narrow = await region.evaluate((node) => {
    const frame = node.getBoundingClientRect();
    const tabs = node.querySelector('[role="tablist"]');
    const scroller = node.closest(".response-body");
    const viewport = scroller.getBoundingClientRect();
    const centers = [...tabs.querySelectorAll('[role="tab"]')].map((item) => {
      const { x, y, width, height } = item.getBoundingClientRect();
      const center = { x: x + width / 2, y: y + height / 2 };
      const hit = document.elementFromPoint(center.x, center.y);
      return {
        name: item.textContent,
        ...center,
        hit: item === hit || item.contains(hit),
        withinScroller: y >= viewport.top && y + height <= viewport.bottom,
      };
    });
    return {
      left: frame.left,
      right: frame.right,
      tabWidth: tabs.clientWidth,
      tabScrollWidth: tabs.scrollWidth,
      docWidth: document.documentElement.scrollWidth,
      scrollTop: scroller.scrollTop,
      wheel: {
        x: viewport.left + viewport.width / 2,
        y: viewport.top + viewport.height / 2,
      },
      centers,
    };
  });
  console.log(
    "HTTP_UNSENT_ACTUAL_REQUEST_NARROW_INITIAL",
    JSON.stringify(narrow),
  );
  await capture("initial-narrow-dark");
  assert(narrow.left >= 0 && narrow.right <= 430.5, JSON.stringify(narrow));
  assert.equal(narrow.docWidth, 430);
  assert.equal(narrow.tabWidth, narrow.tabScrollWidth);
  assert.equal(narrow.scrollTop, 0);
  assert.deepEqual(
    narrow.centers.map(({ name, hit, withinScroller }) => [
      name,
      hit,
      withinScroller,
    ]),
    ["Header", "Query", "Path", "Body"].map((name) => [name, true, true]),
    JSON.stringify(narrow),
  );

  const bodyCenter = narrow.centers[3];
  await page.mouse.click(bodyCenter.x, bodyCenter.y);
  await selected("Body", "未定义请求体");
  assert.equal(await active(tab("Body")), true);
  await tab("Body").press("Tab");
  assert.equal(await active(panel("Body")), true);
  await page.mouse.move(narrow.wheel.x, narrow.wheel.y);
  await page.mouse.wheel(0, 200);
  await page.waitForFunction(
    () => document.querySelector(".response-body").scrollTop > 0,
  );
  await page.waitForFunction(() => {
    const label = document.querySelector(
      "#actual-unsent-panel-body .unsent-response-message p",
    );
    const { x, y, width, height } = label.getBoundingClientRect();
    return document.elementFromPoint(x + width / 2, y + height / 2) === label;
  });
  await capture("scrolled-narrow-dark");

  await page.setViewportSize({ width: 1363, height: 1023 });
  await page.locator("#project-select").selectOption(other.id);
  await page.waitForFunction(
    (id) =>
      document.querySelector("#project-select option[selected]")?.value === id,
    other.id,
  );
  await pick("verification");
  await open();
  await selected("Header", "未定义请求头");
  assert.equal(await region.locator(".method").textContent(), "PUT");
  await responseTab("headers").press("Enter");
  assert.equal(await region.count(), 0);
  await response.getByText("暂无数据", { exact: true }).waitFor();
  await responseTab("cookies").press("Enter");
  await response
    .getByRole("table", { name: "响应 Cookie", exact: true })
    .waitFor();
  assert.deepEqual(
    await Promise.all([app.store.get(owner.id), app.store.get(other.id)]),
    baselines,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  console.log(
    "HTTP_UNSENT_ACTUAL_REQUEST_UI_PASS keyboard, request/project isolation, no draft or transport evidence, no writes or dispatch",
  );
} finally {
  try {
    await browser?.close();
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
}
