import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const evidence = process.env.MODEL_WORKSPACE_EVIDENCE;
const root = await mkdtemp("/tmp/workbench-model-workspace-");
const app = await createApp({ root, port: 0 });
let browser;
try {
  const owner = await app.store.create("默认项目");
  const other = await app.store.create("Separate model fixture");
  owner.modelFolders = [{ id: "local-models", name: "Local fixture models" }];
  await app.store.save(owner);
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
  const writes = [];
  const errors = [];
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
      url.pathname === "/api/projects/" + owner.id &&
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
      path: join(evidence, "model-workbench-" + state + ".png"),
      clip: { x: 0, y: 0, width: 1363, height: 980 },
      caret: "hide",
      animations: "disabled",
    });
  const enter = () =>
    page.locator('.rail [data-page="dictionary"]').press("Enter");
  const switchProject = async (id) => {
    await page.locator("#project-select").selectOption(id);
    await page.waitForFunction(
      (id) =>
        document.querySelector(".dictionary-page")?.dataset
          .dictionaryProject === id,
      id,
    );
  };
  const menu = page.locator(".dictionary-model-create");
  const menuSummary = menu.locator(":scope > summary");
  const newModel = menu.getByRole("button", { name: "新建数据模型" });
  const newFolder = menu.getByRole("button", { name: "新建模型目录" });
  const draft = page.getByRole("region", { name: "数据模型草稿" });
  const name = draft.getByRole("textbox", { name: "模型名称" });
  const folder = draft.getByRole("combobox", { name: "模型目录" });
  const raw = draft.getByRole("button", { name: "Raw编辑" });
  const dialog = page.getByRole("dialog");
  const rawInput = dialog.getByRole("textbox", { name: "模型 Schema JSON" });
  const applyRaw = dialog.getByRole("button", { name: "应用到模型草稿" });
  const apply = draft.getByRole("button", { name: "应用到项目草稿" });
  const focusIs = (locator) =>
    locator.evaluate(
      (element) => element.ownerDocument.activeElement === element,
    );

  await page.goto(app.launchUrl);
  await enter();
  await switchProject(owner.id);
  await menuSummary.press("Enter");
  await page.keyboard.press("Tab");
  assert(await focusIs(newModel));
  await capture("new-menu");
  await newFolder.press("Enter");
  await dialog.getByText("模型目录", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await menuSummary.press("Enter");
  await newModel.press("Enter");
  assert(await focusIs(name));
  assert.equal(await name.inputValue(), "");
  assert.equal(await folder.inputValue(), "");
  await draft.getByText("根节点", { exact: true }).waitFor();
  await draft.getByText("object", { exact: true }).waitFor();
  await name.blur();
  await capture("unsaved-editor");
  const bounds = await draft.evaluate((region) =>
    Object.fromEntries(
      [
        ".dictionary-title-strip",
        ".workspace-model-draft",
        ".model-draft-header",
        ".model-draft-location",
        ".model-draft-schema",
        ".model-draft-root",
      ].map((selector) => {
        const element = region
          .closest(".dictionary-surface")
          .querySelector(selector);
        const { x, y, width, height } = element.getBoundingClientRect();
        const { marginTop, marginBottom } = getComputedStyle(element);
        return [selector, { x, y, width, height, marginTop, marginBottom }];
      }),
    ),
  );
  console.log("MODEL_WORKSPACE_FRAME_BOUNDS", JSON.stringify(bounds));
  const frame = bounds[".model-draft-schema"];
  assert.equal(Math.round(frame.x), 380);
  assert(
    Math.abs(frame.y - 167) <= 6,
    "Schema frame should align with native y167",
  );

  await raw.press("Enter");
  assert(await focusIs(rawInput));
  const modal = await dialog.boundingBox();
  await capture("raw-uncommitted");
  console.log("MODEL_WORKSPACE_RAW_BOUNDS", JSON.stringify(modal));
  assert.deepEqual([Math.round(modal.x), Math.round(modal.width)], [242, 880]);
  assert.deepEqual(JSON.parse(await rawInput.inputValue()), {
    type: "object",
    properties: {},
  });
  await rawInput.fill("false");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert(await focusIs(raw));
  assert(await draft.getByText("object", { exact: true }).isVisible());
  await raw.press("Enter");
  await rawInput.fill("[]");
  await applyRaw.press("Enter");
  await page.getByText("模型Schema须为对象或布尔值", { exact: true }).waitFor();
  const schema = {
    type: "array",
    items: { type: "string" },
    description: "Synthetic rows",
  };
  await rawInput.fill(JSON.stringify(schema));
  await applyRaw.press("Enter");
  await dialog.waitFor({ state: "hidden" });
  await draft.getByText("array", { exact: true }).waitFor();
  assert(await focusIs(raw));
  await name.fill("Synthetic Model");
  await folder.selectOption("local-models");

  await draft.getByRole("button", { name: "返回字典" }).press("Enter");
  assert(await draft.isHidden());
  await switchProject(other.id);
  assert(
    await page
      .getByRole("button", { name: "模型草稿", exact: true })
      .isHidden(),
  );
  await switchProject(owner.id);
  await page
    .getByRole("button", { name: "模型草稿", exact: true })
    .press("Enter");
  assert.equal(await name.inputValue(), "Synthetic Model");
  assert.equal(await folder.inputValue(), "local-models");
  assert(await draft.getByText("array", { exact: true }).isVisible());
  await page.setViewportSize({ width: 430, height: 720 });
  assert.deepEqual(
    await page.evaluate(() => {
      const { clientWidth, scrollWidth } = document.documentElement;
      return [window.innerWidth, scrollWidth - clientWidth];
    }),
    [430, 0],
  );
  await raw.press("Enter");
  assert((await dialog.boundingBox()).width < 430);
  await dialog
    .getByRole("button", { name: "取消", exact: true })
    .press("Enter");
  await dialog.waitFor({ state: "hidden" });
  await apply.press("Enter");
  assert(await draft.isHidden());
  const storedModel = page
    .locator(".dictionary-models .card")
    .filter({ hasText: "Synthetic Model" });
  await storedModel.waitFor();

  // Existing edit/folder/Raw modal tools still open using the legacy path.
  await storedModel.locator("[data-edit-dictionary]").press("Enter");
  assert.equal(
    await dialog.locator("#dict-folder").inputValue(),
    "local-models",
  );
  assert.deepEqual(
    JSON.parse(await dialog.locator("#modal-json").inputValue()),
    schema,
  );
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });

  assert.deepEqual((await app.store.get(owner.id)).dictionary, []);
  assert.deepEqual((await app.store.get(other.id)).dictionary, []);
  assert.deepEqual(writes, []);
  assert.deepEqual(blocked, []);
  allowSave = true;
  await page.locator("#save-project").press("Enter");
  await page
    .locator("#saved-state")
    .getByText("✓ 已保存", { exact: true })
    .waitFor();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].length, 1);
  const model = writes[0][0];
  assert(model.id);
  assert.deepEqual(model, {
    id: model.id,
    name: "Synthetic Model",
    folderId: "local-models",
    schema,
  });
  assert.deepEqual((await app.store.get(owner.id)).dictionary, [model]);
  assert.deepEqual((await app.store.get(other.id)).dictionary, []);
  await page.setViewportSize({ width: 1363, height: 1023 });
  await page.reload();
  await enter();
  await storedModel.waitFor();
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  console.log(
    "MODEL_WORKSPACE_PASS keyboard/new/raw/project-isolation/narrow/explicit-save",
    { frame, modal },
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
