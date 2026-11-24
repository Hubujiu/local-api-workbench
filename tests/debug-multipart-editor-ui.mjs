import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const root = await mkdtemp(join(tmpdir(), "workbench-debug-multipart-"));
const app = await createApp({ root, port: 0 });
let browser;
try {
  const owner = await app.store.create("Switch Visual Fixture B");
  owner.requests = [
    normalizeRequest({
      id: "multipart-ref",
      name: "Multipart Visual Fixture",
      method: "POST",
      url: "http://127.0.0.1:1/never-send",
      bodyType: "none",
      form: [],
    }),
  ];
  const baseline = await app.store.save(owner);
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
  page.setDefaultTimeout(7500);
  const origin = new URL(app.launchUrl).origin;
  const blocked = [],
    errors = [],
    metrics = {};
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((owner) => {
    sessionStorage.setItem("project", owner);
    localStorage.setItem("theme", "light");
  }, owner.id);
  await page.route("**/*", (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.origin === origin && req.method() === "GET")
      return route.continue();
    blocked.push([req.method(), url.pathname]);
    return route.abort();
  });
  await page.goto(app.launchUrl);
  const editor = page.locator('.editor[data-editor-mode="debug"]');
  const bodyTab = editor.locator('.param-tabs [data-param="body"]');
  const radios = (type) =>
    editor.locator(`input[name="body-type"][value="${type}"]`);
  const table = editor.getByRole("table", {
    name: "multipart 参数",
    exact: true,
  });
  const scroller = editor.getByRole("region", { name: "表单参数，可横向滚动" });
  const all = table.getByRole("checkbox", { name: "启用全部表单参数" });
  const composer = table.getByRole("textbox", { name: "新表单参数名" });
  const explicit = table.getByRole("button", {
    name: "添加表单参数",
    exact: true,
  });
  const rows = table.locator("[data-multipart-row]");
  const theme = page.locator("#theme");
  const focus = (target) =>
    target.evaluate((node) => node === document.activeElement);
  const evidence = process.env.DEBUG_MULTIPART_EVIDENCE;
  const capture = async (label, narrow = false) => {
    if (!evidence) return;
    await mkdir(evidence, { recursive: true });
    await page.mouse.move(narrow ? 423 : 1300, 87);
    await page.screenshot({
      path: join(evidence, "debug-multipart-" + label + ".png"),
      caret: "hide",
      animations: "disabled",
      ...(narrow ? {} : { clip: { x: 355, y: 184, width: 1008, height: 265 } }),
    });
  };
  const measures = () =>
    table.evaluate((node) => {
      const box = (element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return [x, y, width, height].map(Math.round);
      };
      return {
        table: box(node.closest(".debug-multipart-scroll")),
        rows: [...node.querySelectorAll("tr")].map(box),
        headers: [...node.querySelectorAll("th")].map(box),
      };
    });
  const top = () =>
    scroller.evaluate(async (node) => {
      for (const el of [
        node,
        node.closest(".request-panel"),
        node.ownerDocument.scrollingElement,
      ]) {
        el.scrollTop = 0;
        el.scrollLeft = 0;
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

  await bodyTab.click();
  await editor.locator("#url").fill("");
  await radios("form-data").press("Space");
  await table.waitFor();
  assert.equal(await focus(radios("form-data")), true);
  assert.equal(await all.isDisabled(), true);
  assert.equal(await rows.count(), 0);
  assert.equal(await bodyTab.innerText(), "Body");
  await composer.fill(" \t ");
  await composer.blur();
  assert.equal(await rows.count(), 0, "blank composer does not add a row");
  await composer.fill("");
  await bodyTab.focus();
  metrics.empty = await measures();
  console.log("DEBUG_MULTIPART_EMPTY_GEOMETRY", JSON.stringify(metrics.empty));
  await capture("empty-light");
  assert.deepEqual(metrics.empty.table.slice(0, 3), [371, 273, 976]);
  assert.equal(metrics.empty.rows.length, 2);
  assert.ok(
    metrics.empty.rows.every(([, , , height]) => height >= 36 && height <= 37),
  );
  assert.ok(Math.abs(metrics.empty.headers[2][0] - 641) <= 5);
  assert.ok(Math.abs(metrics.empty.headers[3][0] - 874) <= 5);

  await composer.fill("profile");
  assert.equal(await rows.count(), 1);
  const first = rows.nth(0),
    second = rows.nth(1);
  const firstKey = first.getByRole("textbox", { name: "参数名", exact: true });
  assert.equal(await focus(firstKey), true);
  await first
    .getByRole("textbox", { name: "参数值", exact: true })
    .fill("sample");
  await composer.fill("payload");
  assert.equal(await rows.count(), 2);
  const type = second.getByRole("combobox", { name: "字段类型", exact: true });
  await type.focus();
  await type.selectOption("file");
  assert.equal(await focus(type), true);
  const file = second.locator('[data-field-file="1"]');
  assert.equal(await file.evaluate((node) => node.files.length), 0);
  assert.equal(
    await second.getByText("请选择文件", { exact: true }).isVisible(),
    true,
  );
  assert.equal(await bodyTab.innerText(), "Body (2)");
  assert.equal(await all.isChecked(), true);
  await bodyTab.focus();
  metrics.populated = await measures();
  assert.equal(metrics.populated.rows.length, 4);
  assert.ok(
    metrics.populated.rows.every(
      ([, , , height]) => height >= 36 && height <= 37,
    ),
  );
  await capture("populated-light");
  await theme.click();
  await top();
  assert.deepEqual(await measures(), metrics.populated);
  await capture("populated-dark");
  await theme.click();

  await first.getByRole("checkbox").uncheck();
  assert.equal(await all.evaluate((node) => node.indeterminate), true);
  await all.check();
  assert.equal(await first.getByRole("checkbox").isChecked(), true);
  await all.uncheck();
  assert.equal(await second.getByRole("checkbox").isChecked(), false);
  await all.check();
  await explicit.press("Enter");
  assert.equal(await rows.count(), 3);
  assert.equal(
    await focus(
      rows.nth(2).getByRole("textbox", { name: "参数名", exact: true }),
    ),
    true,
  );
  assert.equal(await bodyTab.innerText(), "Body (2)");
  await rows
    .nth(2)
    .getByRole("button", { name: "删除参数", exact: true })
    .click();
  await radios("urlencoded").click();
  await page
    .locator("#toast")
    .getByText(/URLencoded 不支持文件/)
    .waitFor();
  assert.equal(await radios("form-data").isChecked(), true);
  await radios("raw").check();
  assert.equal(await table.count(), 0);
  await radios("form-data").check();
  assert.equal(await firstKey.inputValue(), "profile");
  assert.equal(await type.inputValue(), "file");
  assert.equal(await file.evaluate((node) => node.files.length), 0);
  assert.equal(await page.locator("#url").inputValue(), "");

  // Legacy form-schema smoke exercises the dense multipart action lane at
  // 1000 and 1440. Tables may scroll in their own region on narrow screens,
  // but their row actions must stay within the table's last column.
  for (const width of [1440, 1000, 760, 680, 430]) {
    await page.setViewportSize({ width, height: 760 });
    await top();
    const layout = await first.evaluate((row) => {
      const table = row.closest("table");
      const scroller = table.parentElement;
      const cell = row.lastElementChild.getBoundingClientRect();
      const buttons = [...row.lastElementChild.querySelectorAll("button")].map(
        (button) => button.getBoundingClientRect(),
      );
      return {
        table: [table.clientWidth, table.scrollWidth],
        scroller: [scroller.clientWidth, scroller.scrollWidth],
        panel: row.closest(".request-panel").getBoundingClientRect().width,
        buttons: buttons.map(({ left, top, right }) => [left, top, right]),
        actionCell: [cell.left, cell.right],
        documentWidth: document.documentElement.scrollWidth,
      };
    });
    const diagnostic = `${width}px multipart layout: ${JSON.stringify(layout)}`;
    console.log("DEBUG_MULTIPART_ACTION_LAYOUT", diagnostic);
    assert.equal(layout.documentWidth, width, diagnostic);
    assert.ok(layout.scroller[0] <= layout.panel + 1, diagnostic);
    if (layout.table[0] > layout.scroller[0])
      assert.ok(layout.scroller[1] > layout.scroller[0], diagnostic);
    assert.ok(layout.table[1] - layout.table[0] <= 1, diagnostic);
    metrics[`actionLayout${width}`] = layout;
    assert.ok(
      layout.buttons.every(
        ([left, , right]) =>
          left >= layout.actionCell[0] - 1 && right <= layout.actionCell[1] + 1,
      ),
      diagnostic,
    );
    assert.ok(
      layout.buttons.every(
        ([, top]) => Math.abs(top - layout.buttons[0][1]) <= 2,
      ),
      diagnostic,
    );
  }

  await page.setViewportSize({ width: 430, height: 760 });
  await top();
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  assert.equal(
    await scroller.evaluate((node) => node.scrollWidth > node.clientWidth),
    true,
  );
  await capture("narrow-light", true);
  await scroller.focus();
  await file.focus();
  assert.equal(await focus(file), true);
  // Exercise the real local file-selection hook after the no-file screenshots.
  await file.setInputFiles({
    name: "synthetic.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("local fixture only"),
  });
  await second.getByText("synthetic.txt", { exact: true }).waitFor();
  assert.equal(await page.locator(".response .metrics").innerText(), "");
  assert.match(await page.locator("#saved-state").innerText(), /未保存/);
  assert.deepEqual(await app.store.get(owner.id), baseline);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  if (evidence)
    await writeFile(
      join(evidence, "debug-multipart-metrics.json"),
      JSON.stringify({ metrics, blocked, errors }, null, 2) + "\n",
    );
  console.log(
    "DEBUG_MULTIPART_EDITOR_UI_PASS 1363+1440+1000+760+680+430/inline-composer/real-file/keyboard/toggle-all/draft-only/no-send",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
