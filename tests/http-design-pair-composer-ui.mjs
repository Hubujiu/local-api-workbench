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
        controls: [
          ".design-empty-pair",
          '[data-design-query-draft-enabled="row"]',
        ].map((selector) => {
          const bounds = table.querySelector(selector)?.getBoundingClientRect();
          return (
            bounds && { x: bounds.x, right: bounds.right, width: bounds.width }
          );
        }),
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
    assert.deepEqual(geometry.insideRules, ["0px", "0px"]);
    if (equality) {
      near(geometry.equality, 687, 3);
      const [addButton, enabledBox] = geometry.controls;
      const firstCell = geometry.cells[0];
      const nameCell = geometry.cells[1];
      assert(enabledBox.x >= firstCell.x);
      assert(enabledBox.right <= firstCell.x + firstCell.width);
      assert(addButton.x >= nameCell.x);
      assert(addButton.right <= nameCell.x + nameCell.width);
      assert(addButton.width >= 24);
    } else {
      near(geometry.add, 399, 4);
      assert.equal(geometry.equality, null);
    }
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
  const queryMarks = () =>
    panel.locator(".design-pairs-query-empty").evaluate((table) => {
      const control = (key) => {
        const input = table.querySelector(
          `[data-design-query-draft-enabled="${key}"]`,
        );
        const { x, y, width, height } = input.getBoundingClientRect();
        const { appearance, backgroundImage } = getComputedStyle(input);
        return { x, y, width, height, appearance, backgroundImage };
      };
      const type = table.querySelector("[data-design-query-draft-type]");
      const ink = document.createRange();
      ink.selectNodeContents(type);
      return {
        head: control("header"),
        row: control("row"),
        typeStart: ink.getBoundingClientRect().x,
        typeFont: getComputedStyle(type).fontSize,
      };
    });
  const desktopQueryMarks = await queryMarks();
  console.log("DESIGN_QUERY_EMPTY_MARKS", JSON.stringify(desktopQueryMarks));
  for (const [mark, y] of [
    [desktopQueryMarks.head, 588],
    [desktopQueryMarks.row, 624],
  ]) {
    assert.equal(mark.width, 16);
    assert.equal(mark.height, 16);
    near(mark.x, 392, 2);
    near(mark.y, y, 2);
  }
  assert.equal(desktopQueryMarks.head.appearance, "auto");
  assert.equal(desktopQueryMarks.row.appearance, "none");
  assert.match(desktopQueryMarks.row.backgroundImage, /^url/);
  near(desktopQueryMarks.typeStart, 615, 3);
  assert.equal(desktopQueryMarks.typeFont, "14px");
  await tab("Query").blur();
  await capture("query-empty-desktop-neutral");
  await page.emulateMedia({ forcedColors: "active" });
  const forcedQueryMarks = await queryMarks();
  assert.equal(forcedQueryMarks.head.appearance, "auto");
  assert.equal(forcedQueryMarks.row.appearance, "auto");
  assert.equal(forcedQueryMarks.row.backgroundImage, "none");
  await page.emulateMedia({ forcedColors: "none" });
  await page.locator("#theme").press("Enter");
  const darkSurface = await emptySurface();
  assert.equal(darkSurface.borderCollapse, "collapse");
  assert.equal(darkSurface.fontSize, "12px");
  assert.equal((await queryMarks()).row.appearance, "auto");
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
  const draftType = panel.locator("[data-design-query-draft-type]");
  const draftRequired = panel.getByRole("button", {
    name: "待命名 Query 参数必填",
  });
  const draftHeader = panel.getByRole("checkbox", {
    name: "启用待命名 Query 参数（表头）",
    exact: true,
  });
  const draftEnabled = panel.getByRole("checkbox", {
    name: "启用待命名 Query 参数",
    exact: true,
  });
  const typeMenu = panel.getByRole("menu", { name: "Query 标量类型" });
  const chooseInteger = async () => {
    await draftType.press("ArrowDown");
    assert.deepEqual(
      await typeMenu.getByRole("menuitemradio").allTextContents(),
      ["string", "number", "integer", "boolean"],
    );
    await typeMenu
      .getByRole("menuitemradio", { name: "integer", exact: true })
      .press("Enter");
    assert.equal(await draftType.innerText(), "integer");
    assert.equal(await focus(draftType), true);
  };
  assert.equal(await draftType.innerText(), "string");
  assert.equal(await draftRequired.getAttribute("aria-pressed"), "false");
  assert.equal(await draftHeader.isChecked(), true);
  assert.equal(await draftEnabled.isChecked(), true);
  await add().press("Enter");
  assert.equal(await focus(compose("Query")), true);
  await chooseInteger();
  await draftRequired.press("Enter");
  await draftHeader.press("Space");
  assert.equal(await draftRequired.getAttribute("aria-pressed"), "true");
  assert.equal(await draftEnabled.isChecked(), false);
  await draftEnabled.press("Space");
  assert.equal(await draftHeader.isChecked(), true);
  await draftHeader.press("Space");
  assert.equal(await draftEnabled.isChecked(), false);
  const provisionalStatus = panel.getByRole("status");
  await provisionalStatus.waitFor();
  assert.equal(
    await provisionalStatus.textContent(),
    "待命名 Query 参数选项尚未加入接口；填写参数名后才能保存。",
  );
  await capture("query-provisional-desktop");
  await page.locator("#save-project").press("Enter");
  await page
    .getByText(/待命名 Query 参数选项未保存：请返回设计 Query/)
    .waitFor();
  assert.equal(await all("query").count(), 0);
  assert.deepEqual(writes, []);
  assert.deepEqual(await app.store.get(owner.id), baseline);

  await draftType.press("ArrowDown");
  const staleDraft = await typeMenu
    .getByRole("menuitemradio", { name: "boolean" })
    .elementHandle();
  await page.locator('[data-open-tab="preserved"]').press("Enter");
  await tab("Query").press("Enter");
  await staleDraft.evaluate((node) => node.click());
  assert.equal(await draftType.innerText(), "string");
  assert.equal(await draftRequired.getAttribute("aria-pressed"), "false");
  assert.equal(await draftEnabled.isChecked(), true);
  await draftRequired.press("Enter");
  await page.locator('[data-close-tab="preserved"]').press("Enter");
  await tab("Query").press("Enter");
  assert.equal(await draftType.innerText(), "string");
  assert.equal(await draftRequired.getAttribute("aria-pressed"), "false");
  assert.equal(await draftEnabled.isChecked(), true);
  await request("preserved").click();
  await page.locator('[data-open-tab="authored"]').press("Enter");
  await tab("Query").press("Enter");
  await chooseInteger();
  await draftRequired.press("Enter");
  await draftHeader.press("Space");
  await compose("Query").fill(" filter+raw ");
  assert.equal(await panel.locator(".design-pairs-query-empty").count(), 0);
  assert.equal(await draftType.count(), 0);
  assert.equal(await key("query").inputValue(), " filter+raw ");
  assert.equal(
    await panel
      .getByRole("button", { name: /更改 .* 的类型：integer/ })
      .count(),
    1,
  );
  assert.equal(
    await panel
      .locator("[data-design-query-required]")
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(
    await panel.locator('[data-pair-enabled="query:0"]').isChecked(),
    false,
  );
  await panel.locator('[data-pair-enabled="query:0"]').check();
  await value("query").fill("001");
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
  assert.equal((await queryMarks()).row.appearance, "auto");
  await page.locator("#theme").press("Enter");
  await chooseInteger();
  await draftHeader.press("Space");
  assert.equal(await draftEnabled.isChecked(), false);
  await capture("query-provisional-narrow-dark");
  await panel.getByRole("button", { name: "重置待命名选项" }).press("Enter");
  assert.equal(await focus(compose("Query")), true);
  assert.equal(await draftType.innerText(), "string");
  assert.equal(await draftEnabled.isChecked(), true);
  await page.locator("#theme").press("Enter");
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
    {
      key: " filter+raw ",
      value: "001",
      enabled: true,
      schema: { type: "integer" },
      required: true,
    },
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
  await tab("Query").press("Enter");
  assert.equal(await value("query").inputValue(), "001");
  assert.equal(
    await panel
      .locator("[data-design-query-required]")
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.match(
    await panel.locator("[data-design-query-type]").innerText(),
    /integer/,
  );
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
