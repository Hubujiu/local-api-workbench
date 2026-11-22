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
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error("MODEL_WORKSPACE_PAGE_ERROR", error.message);
  });
  await page.addInitScript(() => {
    window.__modelTreeCSP = [];
    window.addEventListener("securitypolicyviolation", (event) => {
      if (event.target?.matches?.(".model-schema-field"))
        window.__modelTreeCSP.push({
          directive: event.effectiveDirective,
          source: event.sourceFile,
          line: event.lineNumber,
          column: event.columnNumber,
        });
    });
  });
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
  await name.blur();
  await capture("unsaved-editor");
  const rootToggle = draft.getByRole("button", { name: "根节点", exact: true });
  await rootToggle.waitFor();
  await draft.getByText("object", { exact: true }).waitFor();
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
    Math.abs(frame.y - 167) <= 2,
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
  const rootAdd = draft.getByRole("button", { name: "添加子级节点" });
  const fields = draft.getByRole("list", { name: "模型字段" });
  const pending = fields.locator(".model-pending-field");
  const children = fields.locator(".model-schema-field");
  const inputField = (row) => row.getByRole("textbox", { name: "字段名称" });
  const first = inputField(pending.first());
  const plus = await rootAdd.boundingBox();
  assert(Math.abs(plus.x + plus.width / 2 - 661) <= 2);
  assert(Math.abs(plus.y + plus.height / 2 - 229) <= 4);
  await rootToggle.press("Enter");
  assert.equal(await rootToggle.getAttribute("aria-expanded"), "false");
  assert(await fields.isHidden());
  await rootAdd.press("Enter");
  assert.equal(await rootToggle.getAttribute("aria-expanded"), "true");
  assert(await focusIs(first));
  assert.equal(await first.inputValue(), "");
  await capture("field-add");
  const pendingBounds = await pending.first().boundingBox();
  const nameBounds = await first.boundingBox();
  console.log(
    "MODEL_WORKSPACE_INLINE_BOUNDS",
    JSON.stringify({ plus, pendingBounds, nameBounds }),
  );
  assert(Math.abs(nameBounds.x - 433) <= 2);
  assert(Math.abs(pendingBounds.y - 246) <= 2);
  assert.equal(Math.round(pendingBounds.height), 32);
  const expandedFrame = await draft
    .locator(".model-draft-schema")
    .boundingBox();
  assert.equal(Math.round(expandedFrame.height - frame.height), 32);
  await pending
    .first()
    .getByRole("button", { name: "添加相邻字段" })
    .press("Enter");
  const second = inputField(pending.nth(1));
  assert.equal(await pending.count(), 2);
  assert(await focusIs(second));
  await capture("field-sibling");
  await first.press("Enter");
  const fieldAlert = pending.first().getByRole("alert");
  await fieldAlert.waitFor();
  assert.equal(await fieldAlert.textContent(), "字段名不能为空且至多200字符");
  await first.fill("identifier");
  await second.fill("discarded");
  await raw.press("Enter");
  await page
    .getByText("请先确认或取消正在添加的字段", { exact: true })
    .waitFor();
  assert(await dialog.isHidden());
  await second.press("Escape");
  assert.equal(await pending.count(), 1);
  assert(await focusIs(first));
  assert.equal(await first.inputValue(), "identifier");
  await first.press("Enter");
  assert.equal(await pending.count(), 0);
  assert(await focusIs(rootAdd));
  await children.getByText("identifier", { exact: true }).waitFor();
  assert(await children.getByText("string", { exact: true }).isVisible());
  const identifier = children.getByText("identifier", { exact: true });
  assert.equal(
    await children.first().getAttribute("data-model-field-depth"),
    "1",
  );
  assert.equal(
    await identifier.evaluate(
      (node) => getComputedStyle(node).paddingInlineStart,
    ),
    "34px",
  );
  await rootAdd.press("Enter");
  await first.fill("identifier");
  await pending
    .first()
    .getByRole("button", { name: "确认字段", exact: true })
    .press("Enter");
  await fieldAlert.waitFor();
  assert.equal(await fieldAlert.textContent(), "字段已存在");
  await pending
    .first()
    .getByRole("button", { name: "取消字段", exact: true })
    .press("Enter");
  assert.equal(await children.count(), 1);
  await rootToggle.press("Enter");
  assert(await children.first().isHidden());
  await rootToggle.press("Enter");
  assert(await children.first().isVisible());

  await raw.press("Enter");
  const fromInline = JSON.parse(await rawInput.inputValue());
  assert.deepEqual(fromInline, {
    type: "object",
    properties: { identifier: { type: "string" } },
  });
  await rawInput.fill("[]");
  await applyRaw.press("Enter");
  await page.getByText("模型Schema须为对象或布尔值", { exact: true }).waitFor();
  const schema = {
    ...fromInline,
    description: "Synthetic rows",
    required: ["identifier"],
    properties: {
      identifier: { type: "integer", description: "Synthetic value" },
    },
  };
  await rawInput.fill(JSON.stringify(schema));
  await applyRaw.press("Enter");
  await dialog.waitFor({ state: "hidden" });
  await children.getByText("integer", { exact: true }).waitFor();
  assert.equal(
    await children
      .getByRole("button", { name: "identifier 必需", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  assert(
    await children.getByText("Synthetic value", { exact: true }).isVisible(),
  );
  assert(await focusIs(raw));
  await capture("field-populated");
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
  assert(await children.getByText("integer", { exact: true }).isVisible());
  await page.setViewportSize({ width: 430, height: 720 });
  assert.deepEqual(
    await page.evaluate(() => {
      const { clientWidth, scrollWidth } = document.documentElement;
      return [window.innerWidth, scrollWidth - clientWidth];
    }),
    [430, 0],
  );
  assert.equal(
    await identifier.evaluate(
      (node) => getComputedStyle(node).paddingInlineStart,
    ),
    "13px",
  );
  assert.deepEqual(await page.evaluate(() => window.__modelTreeCSP), []);
  await rootAdd.press("Enter");
  await first.fill("narrow-synthetic");
  assert(await focusIs(first));
  const fieldBounds = await first.boundingBox();
  assert(fieldBounds.width > 40 && fieldBounds.x + fieldBounds.width < 430);
  await first.press("Escape");
  assert.equal(await pending.count(), 0);
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
    "MODEL_WORKSPACE_PASS keyboard/new/root/inline-field/raw/project-isolation/narrow/explicit-save",
    { frame, modal },
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
