import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const evidence = process.env.MODEL_FIELD_TYPE_EVIDENCE;
const root = await mkdtemp("/tmp/workbench-model-field-type-");
const app = await createApp({ root, port: 0 });
let browser;
try {
  const project = await app.store.create("默认项目");
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
  });
  const origin = new URL(app.launchUrl).origin;
  const blocked = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin === origin && request.method() === "GET")
      return route.continue();
    blocked.push(request.method() + " " + url.pathname);
    return route.abort();
  });
  if (evidence) await mkdir(evidence, { recursive: true });
  const capture = (state) =>
    evidence &&
    page.screenshot({
      path: join(evidence, "model-workbench-type-" + state + ".png"),
      clip: { x: 0, y: 0, width: 1363, height: 980 },
      caret: "hide",
      animations: "disabled",
    });
  const focusIs = (locator) =>
    locator.evaluate(
      (element) => element.ownerDocument.activeElement === element,
    );

  await page.goto(app.launchUrl);
  await page.locator('.rail [data-page="dictionary"]').press("Enter");
  await page.locator(".dictionary-model-create > summary").press("Enter");
  await page
    .locator(".dictionary-model-create")
    .getByRole("button", { name: "新建数据模型" })
    .press("Enter");
  const draft = page.getByRole("region", { name: "数据模型草稿" });
  await draft.getByRole("button", { name: "添加子级节点" }).press("Enter");
  const field = draft.getByRole("textbox", { name: "字段名称" });
  await field.fill("exampleField");
  await field.press("Enter");
  const chip = (name, type) =>
    draft.getByRole("button", {
      name: name + " 的字段类型：" + type,
      exact: true,
    });
  const menu = draft.getByRole("menu", { name: "字段类型" });
  const option = (name) =>
    menu.getByRole("menuitemradio", { name, exact: true });
  const string = chip("exampleField", "string");
  const number = chip("exampleField", "number");
  await string.press("Enter");
  await menu.waitFor();
  assert(await focusIs(option("string")));
  assert.equal(await option("string").getAttribute("aria-checked"), "true");
  assert.deepEqual(await menu.getByRole("menuitemradio").allTextContents(), [
    "string",
    "number",
    "integer",
    "boolean",
    "object",
    "array",
    "null",
  ]);
  await capture("menu");
  const triggerBounds = await string.boundingBox();
  const menuBounds = await menu.boundingBox();
  console.log(
    "MODEL_FIELD_TYPE_DESKTOP",
    JSON.stringify({ triggerBounds, menuBounds }),
  );
  assert(Math.abs(triggerBounds.x - 673) <= 2);
  assert(Math.abs(menuBounds.x - 730) <= 8);
  assert.equal(Math.round(menuBounds.width), 98);

  await page.keyboard.press("End");
  assert(await focusIs(option("null")));
  await page.keyboard.press("Home");
  assert(await focusIs(option("string")));
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  assert(await focusIs(string));
  assert.equal(await string.getAttribute("aria-expanded"), "false");
  await string.press("ArrowDown");
  await page.keyboard.press("Enter");
  await menu.waitFor({ state: "hidden" });
  assert(await focusIs(string));
  await string.click();
  await menu.waitFor();
  await draft.getByRole("heading", { name: "数据结构" }).click();
  await menu.waitFor({ state: "hidden" });
  await page.waitForFunction(
    () =>
      document
        .querySelector("#model-type-trigger-0")
        ?.getAttribute("aria-expanded") === "false",
  );

  await string.press("Enter");
  await page.keyboard.press("ArrowDown");
  assert(await focusIs(option("number")));
  await page.keyboard.press("Enter");
  await number.waitFor();
  assert(await focusIs(number));
  assert(await menu.isHidden());
  await capture("number");

  const raw = draft.getByRole("button", { name: "Raw编辑" });
  const dialog = page.getByRole("dialog");
  const rawInput = dialog.getByRole("textbox", { name: "模型 Schema JSON" });
  await raw.press("Enter");
  const schema = JSON.parse(await rawInput.inputValue());
  assert.deepEqual(schema, {
    type: "object",
    properties: { exampleField: { type: "number" } },
  });
  schema.properties.protected = {
    type: "string",
    minLength: 3,
    default: "safe",
    description: "Synthetic description",
  };
  schema.properties.linked = { type: "string", $ref: "#/properties/protected" };
  schema.required = ["protected"];
  await rawInput.fill(JSON.stringify(schema));
  await dialog.getByRole("button", { name: "应用到模型草稿" }).press("Enter");
  await dialog.waitFor({ state: "hidden" });
  assert(await chip("linked", "string").isHidden());

  await page.setViewportSize({ width: 430, height: 720 });
  const protectedChip = chip("protected", "string");
  await protectedChip.press("Enter");
  await menu.waitFor();
  const narrow = await menu.boundingBox();
  assert(narrow.x >= 0 && narrow.x + narrow.width <= 430);
  assert(narrow.y >= 0 && narrow.y + narrow.height <= 720);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page
    .getByText("该类型会与现有字段约束或值冲突，请用 Raw 编辑", { exact: true })
    .waitFor();
  assert(await focusIs(protectedChip));
  await raw.press("Enter");
  assert.deepEqual(JSON.parse(await rawInput.inputValue()), schema);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual((await app.store.get(project.id)).dictionary, []);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  console.log(
    "MODEL_FIELD_TYPE_PASS anchored/keyboard/outside/raw/constraints/narrow/no-writes",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
