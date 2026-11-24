import { pickProjectUI } from "./helpers/pick-project-ui.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const evidence = process.env.DICTIONARY_ENTRY_EVIDENCE;
const root = await mkdtemp("/tmp/workbench-dictionary-entry-");
const app = await createApp({ root, port: 0 });
let browser;
try {
  const blank = await app.store.create("默认项目");
  const fixture = await app.store.create("Dictionary editor fixture");
  fixture.parameterDictionary = [
    {
      id: "verified-amount",
      key: "amount",
      note: "Synthetic note",
      type: "number",
      description: "\nLocal synthetic description",
      default: null,
      example: 10.5,
      enum: [null, 10.5],
      required: true,
    },
  ];
  await app.store.save(fixture);
  const original = (await app.store.get(fixture.id)).parameterDictionary;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
  });
  const origin = new URL(app.launchUrl).origin;
  const blocked = [],
    writes = [],
    errors = [];
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
      url.pathname === "/api/projects/" + fixture.id &&
      request.method() === "PUT"
    ) {
      allowSave = false;
      writes.push(request.postDataJSON().parameterDictionary);
      return route.continue();
    }
    blocked.push(request.method() + " " + url.pathname);
    return route.abort();
  });
  if (evidence) await mkdir(evidence, { recursive: true });
  const capture = (state) =>
    evidence &&
    page.screenshot({
      path: join(evidence, "dictionary-workbench-" + state + ".png"),
      clip: { x: 0, y: 0, width: 1363, height: 980 },
      caret: "hide",
      animations: "disabled",
    });
  const enter = () =>
    page.locator('.rail [data-page="dictionary"]').press("Enter");
  const switchProject = async (id) => {
    await pickProjectUI(page, id);
    await enter();
    await page.waitForFunction(
      (id) =>
        document.querySelector(".dictionary-page")?.dataset
          .dictionaryProject === id,
      id,
    );
  };
  const openNew = () =>
    page.getByRole("button", { name: "新增参数" }).press("Enter");
  const openStored = () =>
    page
      .locator('[data-edit-parameter-entry="verified-amount"]')
      .press("Enter");
  const dialog = page.getByRole("dialog");
  const name = dialog.getByRole("textbox", { name: "参数名称" });
  const note = dialog.getByRole("textbox", { name: "备注名" });
  const type = dialog.getByRole("combobox", { name: "参数类型" });
  const description = dialog.getByRole("textbox", { name: "字段描述" });
  const extras = dialog.getByRole("textbox", {
    name: "默认值 / 示例 / 枚举（JSON 对象）",
  });
  const submit = dialog.getByRole("button", { name: "确定", exact: true });
  const focusIs = (locator) =>
    locator.evaluate(
      (element) => element.ownerDocument.activeElement === element,
    );
  await page.goto(app.launchUrl);
  await enter();
  await switchProject(blank.id);
  await openNew();
  assert.equal(await dialog.getAttribute("aria-labelledby"), "dialog-title");
  await dialog.getByText("新建字典参数", { exact: true }).waitFor();
  assert(await focusIs(name));
  assert.deepEqual(
    await Promise.all([
      name.inputValue(),
      note.inputValue(),
      type.inputValue(),
      description.inputValue(),
      extras.inputValue(),
    ]),
    ["", "", "string", "", "{}"],
  );
  const metrics = await dialog.evaluate((frame) => {
    const rect = (element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return [x, y, width, height].map(Math.round);
    };
    return {
      dialog: rect(frame),
      name: rect(frame.querySelector("#dict-key")),
      note: rect(frame.querySelector("#dict-note")),
      type: rect(frame.querySelector("#dict-type")),
    };
  });
  assert.deepEqual([metrics.dialog[0], metrics.dialog[2]], [382, 600]);
  assert.deepEqual(metrics.name.slice(2), [270, 28]);
  assert.deepEqual(metrics.note.slice(2), [270, 28]);
  assert.equal(metrics.name[1], metrics.note[1]);
  assert.equal(metrics.name[0] - metrics.dialog[0], 24);
  assert.equal(metrics.note[0] - metrics.name[0] - metrics.name[2], 12);
  assert.deepEqual(metrics.type.slice(2), [552, 28]);
  assert.equal(metrics.type[1] - metrics.name[1] - metrics.name[3], 12);
  await capture("new-blank");
  await submit.press("Enter");
  await page.getByText("参数名无效", { exact: true }).waitFor();
  assert(await dialog.isVisible());
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });

  await switchProject(fixture.id);
  await openStored();
  await dialog.getByText("编辑字典参数", { exact: true }).waitFor();
  assert.equal(await name.inputValue(), original[0].key);
  assert.equal(await description.inputValue(), original[0].description);
  assert.deepEqual(JSON.parse(await extras.inputValue()), {
    default: null,
    example: 10.5,
    enum: [null, 10.5],
  });
  await capture("edit-stored-fixture");
  await page.setViewportSize({ width: 430, height: 680 });
  assert(
    await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight
      );
    }),
  );
  await note.fill("Discarded note");
  await dialog
    .getByRole("button", { name: "取消", exact: true })
    .press("Enter");
  await dialog.waitFor({ state: "hidden" });
  await openStored();
  assert.equal(await note.inputValue(), "Synthetic note");
  await note.fill("New local note");
  await extras.fill("[]");
  await submit.press("Enter");
  await page.getByText("扩展定义必须是JSON对象", { exact: true }).waitFor();
  await extras.fill(
    JSON.stringify({ default: null, example: 10.5, enum: [null, 10.5] }),
  );
  assert.deepEqual(
    (await app.store.get(fixture.id)).parameterDictionary,
    original,
  );
  assert.deepEqual((await app.store.get(blank.id)).parameterDictionary, []);
  assert.deepEqual(writes, []);
  assert.deepEqual(blocked, []);
  allowSave = true;
  await submit.press("Enter");
  await dialog.waitFor({ state: "hidden" });
  const expected = [{ ...original[0], note: "New local note" }];
  assert.deepEqual(writes, [expected]);
  assert.deepEqual(
    (await app.store.get(fixture.id)).parameterDictionary,
    expected,
  );
  await page.setViewportSize({ width: 1363, height: 1023 });
  await page.reload();
  await enter();
  await openStored();
  assert.equal(await note.inputValue(), "New local note");
  await dialog
    .getByRole("button", { name: "关闭", exact: true })
    .press("Enter");
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  console.log(
    "DICTIONARY_ENTRY_PASS measured/new/edit/cancel/validate/narrow/explicit-fixture-update",
    metrics,
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
