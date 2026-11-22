import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRequest } from "../src/core.mjs";
import { createApp } from "../src/server.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const root = await mkdtemp(join(tmpdir(), "workbench-debug-urlencoded-"));
const app = await createApp({ root, port: 0 });
let browser;
try {
  const owner = await app.store.create("Switch Visual Fixture B");
  const secret = Buffer.from("synthetic private data").toString("base64");
  owner.requests = [
    normalizeRequest({
      id: "urlencoded-visual",
      name: "URLencoded Visual Fixture",
      method: "POST",
      url: "",
      bodyType: "none",
    }),
    normalizeRequest({
      id: "urlencoded-legacy",
      name: "Masked legacy URLencoded",
      method: "POST",
      url: "",
      bodyType: "urlencoded",
      form: [
        {
          key: "legacy",
          type: "text",
          filename: "synthetic-private.bin",
          value: secret,
        },
      ],
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
  await page.addInitScript((id) => {
    sessionStorage.setItem("project", id);
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
  const body = editor.locator('.param-tabs [data-param="body"]');
  const radio = (type) =>
    editor.locator(`input[name="body-type"][value="${type}"]`);
  const table = editor.getByRole("table", {
    name: "URLencoded 参数",
    exact: true,
  });
  const region = table.locator("..");
  const all = table.getByRole("checkbox", { name: "启用全部表单参数" });
  const rows = table.locator("[data-urlencoded-row]");
  const name = (row) =>
    row.getByRole("textbox", { name: "参数名", exact: true });
  const value = (row) =>
    row.getByRole("textbox", { name: "参数值", exact: true });
  const check = (row) =>
    row.getByRole("checkbox", { name: "启用参数", exact: true });
  const composer = table.getByRole("textbox", { name: "新表单参数名" });
  const evidence = process.env.DEBUG_URLENCODED_EVIDENCE;
  const capture = async (label, crop = true) => {
    if (!evidence) return;
    await mkdir(evidence, { recursive: true });
    await page.screenshot({
      path: join(evidence, label + ".png"),
      caret: "hide",
      animations: "disabled",
      ...(crop ? { clip: { x: 355, y: 184, width: 1008, height: 265 } } : {}),
    });
  };
  const measure = () =>
    table.evaluate((el) => {
      const rect = (node) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return [x, y, width, height].map(Math.round);
      };
      const pane = el.parentElement;
      const actions = [...el.querySelectorAll("tbody td button:not(.ghost)")];
      return {
        frame: rect(pane),
        rows: [...el.rows].map(rect),
        headers: [...el.tHead.rows[0].cells].map(rect),
        doc: document.documentElement.scrollWidth,
        pane: [pane.clientWidth, pane.scrollWidth],
        table: [el.clientWidth, el.scrollWidth],
        actionsContained: actions.every((button) => {
          const element = button.getBoundingClientRect(),
            cell = button.closest("td").getBoundingClientRect();
          return (
            element.right <= cell.right + 1 && element.left >= cell.left - 1
          );
        }),
      };
    });
  const focused = (x) => x.evaluate((el) => el === document.activeElement);
  await body.click();
  await radio("urlencoded").press("Space");
  await table.waitFor();
  assert(await focused(radio("urlencoded")));
  assert.equal(await body.innerText(), "Body");
  assert.equal(await all.isDisabled(), true);
  await composer.fill(" \t ");
  await composer.blur();
  assert.equal(await rows.count(), 0);
  await composer.fill("");
  await body.focus();
  metrics.empty = await measure();
  console.log("DEBUG_URLENCODED_EMPTY", JSON.stringify(metrics.empty));
  await capture("empty");
  assert.deepEqual(metrics.empty.frame.slice(0, 3), [371, 273, 976]);
  assert.equal(metrics.empty.rows.length, 2);
  const lefts = metrics.empty.headers.slice(1, 4).map(([x]) => x + 4);
  assert(
    lefts.every((x, i) => Math.abs(x - [416, 711, 1031][i]) <= 6),
    JSON.stringify(lefts),
  );
  assert(metrics.empty.rows.every(([, , , h]) => h >= 36 && h <= 37));

  await composer.fill("profile");
  assert(await focused(name(rows.nth(0))));
  await value(rows.nth(0)).fill("sample");
  await composer.fill("tag");
  await value(rows.nth(1)).fill("a+b");
  await check(rows.nth(1)).uncheck();
  assert.equal(await body.innerText(), "Body (2)");
  assert(await all.evaluate((el) => el.indeterminate));
  assert.equal(await table.locator("input[type=file], select").count(), 0);
  assert.equal(await editor.locator("#url").inputValue(), "");
  await body.focus();
  metrics.populated = await measure();
  assert.equal(metrics.populated.rows.length, 4);
  assert(metrics.populated.rows.every(([, , , h]) => h >= 36 && h <= 37));
  await capture("populated");

  await all.check();
  assert(await check(rows.nth(1)).isChecked());
  await check(rows.nth(1)).uncheck();
  await radio("raw").press("Space");
  assert(await radio("raw").isChecked());
  assert(await focused(radio("raw")));
  await radio("urlencoded").press("Space");
  assert(await focused(radio("urlencoded")));
  await radio("urlencoded").press("ArrowRight");
  assert(await radio("binary").isChecked());
  assert(await focused(radio("binary")));
  await radio("binary").press("ArrowLeft");
  assert(await radio("urlencoded").isChecked());
  assert(await focused(radio("urlencoded")));
  assert.equal(await rows.count(), 2);
  assert.equal(await value(rows.nth(1)).inputValue(), "a+b");
  assert.equal(await check(rows.nth(1)).isChecked(), false);
  const explicit = table.getByRole("button", {
    name: "添加表单参数",
    exact: true,
  });
  await explicit.press("Enter");
  assert.equal(await rows.count(), 2);
  assert(await focused(composer));
  await composer.fill("temporary");
  assert.equal(await rows.count(), 3);
  assert(await focused(name(rows.nth(2))));
  assert.equal(await body.innerText(), "Body (3)");
  await rows
    .nth(2)
    .getByRole("button", { name: "删除参数", exact: true })
    .click();

  await rows.nth(0).getByRole("button", { name: "定义", exact: true }).click();
  await page.locator("#parameter-description").fill("synthetic note");
  await page.locator("#dialog-save").press("Enter");
  await table.getByText("synthetic note", { exact: true }).waitFor();

  for (const width of [1000, 430]) {
    await page.setViewportSize({ width, height: 760 });
    await region.evaluate((node) => (node.scrollLeft = 0));
    const layout = await measure(),
      message = JSON.stringify(layout);
    metrics[width] = layout;
    console.log("DEBUG_URLENCODED_SIZE", width, message);
    assert.equal(layout.doc, width, message);
    assert(layout.actionsContained, message);
    assert(layout.table[1] - layout.table[0] <= 1, message);
    if (width === 430) assert(layout.pane[1] > layout.pane[0], message);
  }
  await capture("narrow", false);
  const stale = await composer.elementHandle();
  await page.setViewportSize({ width: 1363, height: 1023 });
  await page.locator('#tree [data-request="urlencoded-legacy"]').click();
  await body.press("Enter");
  await page.getByText(/文件数据未作为文本显示/).waitFor();
  assert.equal(await table.count(), 0);
  assert.equal(
    await editor.locator('[data-field-type="0"]').inputValue(),
    "file",
  );
  assert.equal(await editor.locator("input[type=file]").count(), 0);
  const rendered = await editor.locator(".request-panel").innerHTML();
  assert(!rendered.includes(secret));
  assert(!rendered.includes("synthetic-private.bin"));
  await stale.evaluate((input) => {
    input.value = "stale scope";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.equal(await editor.locator('[data-pair="form:1:key"]').count(), 0);
  assert.deepEqual(await app.store.get(owner.id), baseline);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  if (evidence)
    await writeFile(
      join(evidence, "metrics.json"),
      JSON.stringify(metrics, null, 2) + "\n",
    );
  console.log(
    "DEBUG_URLENCODED_EDITOR_UI_PASS native-shape/1363+1000+430/literal+disabled/legacy-mask/no-writes/no-send",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
