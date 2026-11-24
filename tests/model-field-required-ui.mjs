import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const evidence = process.env.MODEL_FIELD_REQUIRED_EVIDENCE;
const root = await mkdtemp("/tmp/workbench-model-field-required-");
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
  const writes = [];
  let allowSave = false;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin === origin && request.method() === "GET")
      return route.continue();
    if (
      allowSave &&
      url.origin === origin &&
      url.pathname === "/api/projects/" + project.id &&
      request.method() === "PUT"
    ) {
      allowSave = false;
      writes.push(request.postDataJSON().dictionary);
      return route.continue();
    }
    blocked.push(request.method() + " " + url.pathname);
    return route.abort();
  });
  if (evidence) await mkdir(evidence, { recursive: true });
  const capture = (state) =>
    evidence &&
    page.screenshot({
      path: join(evidence, "model-workbench-required-" + state + ".png"),
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
  const add = draft.getByRole("button", { name: "添加子级节点" });
  const raw = draft.getByRole("button", { name: "Raw编辑" });
  const dialog = page.getByRole("dialog");
  const rawInput = dialog.getByRole("textbox", { name: "模型 Schema JSON" });
  const closeRaw = async () => {
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
  };
  const fixture = {
    type: "object",
    properties: { exampleField: { type: "number" } },
  };
  await raw.press("Enter");
  await rawInput.fill(JSON.stringify(fixture));
  await dialog.getByRole("button", { name: "应用到模型草稿" }).press("Enter");
  await dialog.waitFor({ state: "hidden" });

  const required = (field) =>
    draft.getByRole("button", { name: field + " 必需", exact: true });
  const button = required("exampleField");
  await button.waitFor();
  const box = await button.boundingBox();
  console.log("MODEL_FIELD_REQUIRED_DESKTOP", JSON.stringify(box));
  assert.deepEqual([box.width, box.height], [20, 20]);
  assert(Math.abs(box.x + box.width / 2 - 797) <= 3);
  await add.press("Enter");
  const pending = draft.getByRole("textbox", { name: "字段名称", exact: true });
  await pending.blur();
  assert.equal(await button.getAttribute("title"), "必需");
  assert.equal(await button.getAttribute("aria-pressed"), "false");
  await capture("before");
  await button.press("Space");
  assert(await focusIs(button));
  assert.equal(await button.getAttribute("aria-pressed"), "true");
  assert.equal(await pending.inputValue(), "");
  await button.blur();
  await capture("after");
  await pending.press("Escape");
  await raw.press("Enter");
  const on = { ...fixture, required: ["exampleField"] };
  assert.deepEqual(JSON.parse(await rawInput.inputValue()), on);
  await capture("raw");
  await closeRaw();
  await button.press("Enter");
  assert.equal(await button.getAttribute("aria-pressed"), "false");
  await raw.press("Enter");
  assert.deepEqual(JSON.parse(await rawInput.inputValue()), fixture);

  const nested = {
    ...on,
    properties: {
      ...on.properties,
      group: {
        type: "object",
        properties: {
          before: { type: "boolean", const: true },
          middle: {
            type: "integer",
            minimum: 1,
            description: "Synthetic nested field",
          },
          after: { type: "string", example: "neutral" },
        },
        required: ["after", "before"],
      },
    },
  };
  await rawInput.fill(JSON.stringify(nested));
  await dialog.getByRole("button", { name: "应用到模型草稿" }).press("Enter");
  await dialog.waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 430, height: 720 });
  const middle = required("middle");
  await middle.press("Space");
  assert(await focusIs(middle));
  const narrow = await middle.boundingBox();
  assert(narrow.x >= 0 && narrow.x + narrow.width <= 430);
  assert.equal(await middle.getAttribute("aria-pressed"), "true");
  assert.equal(await required("before").getAttribute("aria-pressed"), "true");
  assert.equal(await required("after").getAttribute("aria-pressed"), "true");
  await raw.press("Enter");
  const expected = structuredClone(nested);
  expected.properties.group.required.push("middle");
  assert.deepEqual(JSON.parse(await rawInput.inputValue()), expected);
  await closeRaw();

  await draft
    .getByRole("textbox", { name: "模型名称" })
    .fill("Required fixture");
  await draft.getByRole("button", { name: "应用到项目草稿" }).press("Enter");
  assert.deepEqual((await app.store.get(project.id)).dictionary, []);
  assert.deepEqual(writes, []);
  assert.deepEqual(blocked, []);
  allowSave = true;
  await page.locator("#save-project").press("Enter");
  await page
    .locator("#saved-state")
    .getByText("✓ 已保存", { exact: true })
    .waitFor();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0][0].schema, expected);
  assert.deepEqual(
    (await app.store.get(project.id)).dictionary[0].schema,
    expected,
  );
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  console.log(
    "MODEL_FIELD_REQUIRED_PASS on/off/nested/siblings/keyboard/narrow/explicit-fixture-save",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
