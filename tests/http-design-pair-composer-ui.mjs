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
const temp = await mkdtemp(join(tmpdir(), "workbench-design-pairs-"));
const app = await createApp({ root: temp, port: 0 });
const origin = new URL(app.launchUrl).origin;
const errors = [],
  forbidden = [],
  writes = [];
const existing = {
  key: "X-Preserved",
  value: "base",
  enabled: false,
  required: true,
  description: "Existing description",
  schema: { type: "string", maxLength: 20 },
};
let browser;
try {
  let owner = await app.store.create("Design pairs synthetic");
  owner.requests = [
    normalizeRequest({ id: "authored", name: "Verification", url: "" }),
    normalizeRequest({
      id: "preserved",
      name: "Other request",
      url: "",
      headers: [existing],
    }),
  ];
  owner = await app.store.save(owner);
  const baseline = structuredClone(await app.store.get(owner.id));
  const savePath = "/api/projects/" + owner.id;
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
  });
  page.on("pageerror", () => errors.push("unexpected browser error"));
  await page.addInitScript(
    (id) => sessionStorage.setItem("project", id),
    owner.id,
  );
  let maySave = false;
  await page.route("**/*", (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.origin === origin && req.method() === "GET")
      return route.continue();
    if (
      maySave &&
      !writes.length &&
      url.origin === origin &&
      url.pathname === savePath &&
      req.method() === "PUT"
    ) {
      writes.push(req.postDataJSON());
      return route.continue();
    }
    forbidden.push(req.method());
    return route.abort();
  });
  await page.goto(app.launchUrl);
  const mode = (name) => page.locator(`[data-mode="${name}"]`);
  const panel = page.locator("#design-parameter-panel");
  const tab = (name) => page.getByRole("tab", { name, exact: true });
  const compose = (label) =>
    panel.getByRole("textbox", { name: "新" + label + "参数名", exact: true });
  const add = () =>
    panel.getByRole("button", { name: "＋ 添加参数", exact: true });
  const key = (kind, i = 0) => panel.locator(`[data-pair="${kind}:${i}:key"]`);
  const value = (kind, i = 0) =>
    panel.locator(`[data-pair="${kind}:${i}:value"]`);
  const all = (kind) =>
    panel.locator(`[data-pair^="${kind}:"][data-pair$=":key"]`);
  const focus = (el) => el.evaluate((node) => document.activeElement === node);
  const request = (id) => page.locator(`[data-request="${id}"]`);
  const settingsDialog = page.locator("#dialog");
  const capture = async (name) => {
    const dir = process.env.DESIGN_PAIR_COMPOSER_EVIDENCE;
    if (!dir) return;
    await mkdir(dir, { recursive: true });
    await page.screenshot({
      path: join(dir, "design-pair-" + name + ".png"),
      caret: "hide",
      animations: "disabled",
    });
  };

  const emptySurface = () =>
    panel.locator(".design-pairs-empty").evaluate((table) => {
      const { borderCollapse, borderTopLeftRadius } = getComputedStyle(table);
      const { fontSize } = getComputedStyle(table.tHead.rows[0].cells[1]);
      const { borderBottomWidth } = getComputedStyle(
        table.tBodies[0].rows[0].cells[1],
      );
      const bottom = table.getBoundingClientRect().bottom;
      return {
        borderCollapse,
        borderTopLeftRadius,
        fontSize,
        borderBottomWidth,
        bottom,
      };
    });
  const measureEmptyHead = () =>
    panel.locator(".design-pairs-empty").evaluate((table) => {
      const cells = table.tHead.rows[0].cells;
      const text = (node, value) => {
        const child = [...node.childNodes].find(
          (part) =>
            part.nodeType === Node.TEXT_NODE &&
            part.textContent.includes(value),
        );
        const start = child.textContent.indexOf(value);
        const range = document.createRange();
        range.setStart(child, start);
        range.setEnd(child, start + value.length);
        const { left, width } = range.getBoundingClientRect();
        return { x: left, center: left + width / 2 };
      };
      return {
        name: text(cells[1], "参数名").x,
        value: text(cells[2], "参数值").x,
        description: text(cells[3], "描述").x,
        equality:
          cells[2]
            .querySelector(".design-query-equality")
            ?.getBoundingClientRect().x ?? null,
        add: text(table.querySelector(".design-empty-pair"), "＋").center,
        insideRules: [1, 2].map(
          (i) => getComputedStyle(cells[i]).borderRightWidth,
        ),
        cells: [...cells].map((cell) => {
          const { x, width } = cell.getBoundingClientRect();
          return {
            x,
            width,
            padding: getComputedStyle(cell).paddingInlineStart,
          };
        }),
        box: {
          y: table.getBoundingClientRect().y,
          height: table.getBoundingClientRect().height,
        },
      };
    });
  const near = (actual, expected, tolerance) =>
    assert(
      Math.abs(actual - expected) <= tolerance,
      `expected ${actual} within ${tolerance}px of ${expected}`,
    );
  const assertEmptyHeading = (geometry, equality) => {
    near(geometry.name, 416, 3);
    near(geometry.value, 711, 4);
    near(geometry.description, 1031, 3);
    near(geometry.add, 399, 4);
    assert.deepEqual(geometry.insideRules, ["0px", "0px"]);
    if (equality) near(geometry.equality, 687, 3);
    else assert.equal(geometry.equality, null);
    near(geometry.box.height, 73, 2);
  };

  await mode("design").press("Enter");
  await page.locator("#design-description summary").press("Enter");
  await compose("Header").waitFor();
  const geometry = await Promise.all([
    panel.locator("table").boundingBox(),
    panel.locator(".design-pair-composer").boundingBox(),
  ]);
  console.log("DESIGN_PAIR_HEADER_GEOMETRY", JSON.stringify(geometry));
  await capture("header-empty-desktop");
  assert.equal(await panel.locator(".design-pairs-query-empty").count(), 0);
  const headerSurface = await emptySurface();
  assert.equal(headerSurface.borderCollapse, "collapse");
  assert.equal(headerSurface.fontSize, "12px");
  const headerHead = await measureEmptyHead();
  console.log("DESIGN_PAIR_HEADER_HEAD", JSON.stringify(headerHead));
  assertEmptyHeading(headerHead, false);
  assert(Math.abs(geometry[0].x - 371) <= 3);
  assert(Math.abs(geometry[1].height - 36) <= 2);
  await add().press("Enter");
  assert.equal(await focus(compose("Header")), true);
  await compose("Header").fill("   ");
  assert.equal(await all("headers").count(), 0);
  assert.match(await page.locator("#saved-state").textContent(), /已保存/);

  await compose("Header").fill("X");
  assert.equal(await focus(key("headers")), true);
  assert.deepEqual(
    await key("headers").evaluate((node) => [
      node.selectionStart,
      node.selectionEnd,
    ]),
    [1, 1],
  );
  await key("headers").pressSequentially("-Verification");
  assert.equal(await key("headers").inputValue(), "X-Verification");
  await value("headers").fill("local-only");
  await add().press("Enter");
  assert.equal(await focus(compose("Header")), true);
  assert.equal(await all("headers").count(), 1);
  await panel.locator('[data-define-pair="headers:0"]').press("Enter");
  await settingsDialog
    .locator("#parameter-description")
    .fill("Synthetic metadata");
  await settingsDialog.locator("#parameter-required").check();
  await settingsDialog
    .locator("#modal-json")
    .fill('{"type":"string","minLength":1}');
  await settingsDialog.locator("#dialog-save").press("Enter");
  await settingsDialog.waitFor({ state: "hidden" });
  assert.match(await panel.textContent(), /Synthetic metadata/);
  await capture("header-editable-desktop");

  await compose("Header").evaluate((node) => {
    node.value = "stale ownership";
    node.dispatchEvent(
      new InputEvent("input", { isComposing: true, bubbles: true }),
    );
  });
  assert.equal(await all("headers").count(), 1);
  const stale = await compose("Header").elementHandle();
  await request("preserved").click();
  await stale.evaluate((node) =>
    node.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    ),
  );
  assert.equal(await all("headers").count(), 1);
  assert.equal(await key("headers").inputValue(), existing.key);
  await request("authored").click();
  assert.equal(await all("headers").count(), 1);

  await tab("Header").press("ArrowRight");
  assert.equal(await focus(tab("Query")), true);
  assert.equal(await compose("Query").inputValue(), "");
  await capture("query-empty-desktop");
  const queryHead = await measureEmptyHead();
  console.log("DESIGN_PAIR_QUERY_HEAD", JSON.stringify(queryHead));
  assertEmptyHeading(queryHead, true);
  near(queryHead.box.y, 577, 3);
  assert.equal(await panel.locator(".design-pairs-query-empty").count(), 1);
  const querySurface = await emptySurface();
  console.log("DESIGN_QUERY_EMPTY_SURFACE", JSON.stringify(querySurface));
  assert.equal(querySurface.borderCollapse, "separate");
  assert.equal(querySurface.borderTopLeftRadius, "4px");
  assert.equal(querySurface.fontSize, "14px");
  assert.equal(querySurface.borderBottomWidth, "0px");
  near(querySurface.bottom, 651, 1);
  near(queryHead.value, 712, 3);
  await tab("Query").blur();
  await capture("query-empty-desktop-neutral");
  await page.locator("#theme").press("Enter");
  const darkSurface = await emptySurface();
  assert.equal(darkSurface.borderCollapse, "collapse");
  assert.equal(darkSurface.fontSize, "12px");
  await page.locator("#theme").press("Enter");
  const equals = panel.getByRole("checkbox", {
    name: "空值 Query 参数添加等号",
    exact: true,
  });
  assert.equal(await equals.isChecked(), true);
  await equals.press("Space");
  assert.equal(await equals.isChecked(), false);
  await equals.press("Space");
  assert.equal(await equals.isChecked(), true);
  assert.equal(await all("query").count(), 0);
  assert.deepEqual(writes, []);
  await compose("Query").fill(" filter+raw ");
  assert.equal(await panel.locator(".design-pairs-query-empty").count(), 0);
  assert.equal(await key("query").inputValue(), " filter+raw ");
  await value("query").fill("a+b");
  await panel
    .getByRole("checkbox", { name: "空值 Query 参数添加等号" })
    .uncheck();
  await tab("Path").press("Enter");
  assert.equal(await panel.locator("[data-design-pair-name]").count(), 0);
  await mode("debug").press("Enter");
  await page.locator('[data-param="headers"]').press("Enter");
  assert.equal(
    await page.locator('[data-debug-pair-name="headers"]').isVisible(),
    true,
  );
  assert.equal(await page.locator("[data-design-pair-name]").count(), 0);
  await mode("design").press("Enter");
  await tab("Query").press("Enter");
  assert.equal(await key("query").inputValue(), " filter+raw ");

  await page.setViewportSize({ width: 430, height: 830 });
  await add().press("Enter");
  assert.equal(await focus(compose("Query")), true);
  const narrow = await compose("Query").boundingBox();
  assert(narrow.width > 20 && narrow.x >= 0 && narrow.x + narrow.width <= 430);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  assert.equal(await all("query").count(), 1);
  await capture("query-narrow");
  await page.locator('[data-open-tab="preserved"]').press("Enter");
  await tab("Query").press("Enter");
  const compactCols = panel.locator(".design-empty-pair-columns");
  assert.equal(
    await compactCols.evaluate((node) => getComputedStyle(node).display),
    "none",
  );
  assert.equal(await all("query").count(), 0);
  const narrowEmpty = await emptySurface();
  assert.equal(narrowEmpty.borderCollapse, "collapse");
  assert.equal(narrowEmpty.fontSize, "12px");
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  await page.locator('[data-open-tab="authored"]').press("Enter");
  assert.equal(await key("query").inputValue(), " filter+raw ");
  assert.deepEqual(await app.store.get(owner.id), baseline);

  maySave = true;
  const [response] = await Promise.all([
    page.waitForResponse(
      (result) =>
        new URL(result.url()).pathname === savePath &&
        result.request().method() === "PUT",
    ),
    page.locator("#save-project").press("Enter"),
  ]);
  assert.equal(response.status(), 200);
  await page.getByText("✓ 已保存", { exact: true }).waitFor();
  assert.equal(writes.length, 1);
  maySave = false;
  const saved = await app.store.get(owner.id);
  const result = saved.requests.find((item) => item.id === "authored");
  assert.deepEqual(result.headers, [
    {
      key: "X-Verification",
      value: "local-only",
      enabled: true,
      description: "Synthetic metadata",
      required: true,
      schema: { type: "string", minLength: 1 },
    },
  ]);
  assert.deepEqual(result.query, [
    { key: " filter+raw ", value: "a+b", enabled: true },
  ]);
  assert.equal(result.queryAddEqual, false);
  assert.deepEqual(
    saved.requests.find((item) => item.id === "preserved").headers,
    [existing],
  );
  await page.reload();
  await mode("design").press("Enter");
  await tab("Header").press("Enter");
  assert.equal(await key("headers").inputValue(), "X-Verification");
  assert.deepEqual(forbidden, [], "no traffic or automatic save");
  assert.deepEqual(errors, []);
  console.log(
    "DESIGN_PAIR_COMPOSER_UI_PASS keyboard, owner and IME fences, metadata and exact IDs, one deliberate local save",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(temp, { recursive: true, force: true });
}
