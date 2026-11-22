import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";
import { snapshotCase } from "../src/cases.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const evidence = process.env.CASE_DRAWER_EVIDENCE;
const root = await mkdtemp(join(tmpdir(), "workbench-case-drawer-"));
let app, browser;
try {
  app = await createApp({ root, port: 0 });
  const project = await app.store.create("默认项目");
  const original = normalizeRequest({
    id: "verification",
    name: "Verification",
    method: "GET",
    url: "http://127.0.0.1:38982/verification",
  });
  const populated = normalizeRequest({
    ...original,
    id: "populated",
    name: "Verification populated",
  });
  project.requests.push(original, populated);
  project.caseFolders = [
    { id: "checks", name: "Fixture checks", sourceRequestId: populated.id },
  ];
  project.cases = [
    snapshotCase({
      id: "existing-case",
      name: "Verification saved case",
      folderId: "checks",
      sourceRequestId: populated.id,
      request: {
        ...populated,
        url: original.url + "?case=stored",
        assertions: [{ target: "status", op: "eq", value: 200 }],
      },
    }),
  ];
  await app.store.save(project);
  const baseline = await app.store.get(project.id);
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
  page.setDefaultTimeout(8500);
  const origin = new URL(app.launchUrl).origin;
  const blocked = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("theme", "light");
    window.__caseDrawerCSP = [];
    window.addEventListener("securitypolicyviolation", (event) =>
      window.__caseDrawerCSP.push({
        directive: event.effectiveDirective,
        blockedURI: event.blockedURI,
        sourceFile: event.sourceFile,
        line: event.lineNumber,
      }),
    );
  });
  await page.route("**/*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin && request.method() === "GET")
      return route.continue();
    blocked.push([request.method(), url.pathname]);
    return route.abort();
  });
  if (evidence) await mkdir(evidence, { recursive: true });
  const capture = (state) =>
    evidence &&
    page.screenshot({
      path: join(evidence, "case-drawer-" + state + ".png"),
      clip: { x: 0, y: 0, width: 1363, height: 980 },
      caret: "hide",
      animations: "disabled",
    });
  const active = (element) =>
    element.evaluate((node) => node === document.activeElement);
  const selectSource = async (request) => {
    await page.locator('[data-request="' + request.id + '"]').click();
    await page.locator('[data-mode="cases"]').click();
  };
  const create = page.locator("#new-interface-case");
  const edit = page.locator('[data-edit-case="existing-case"]');
  const drawer = page.getByRole("dialog");
  const name = drawer.getByRole("textbox", { name: "用例名称" });
  const folder = drawer.getByRole("combobox", { name: "分组" });
  const json = drawer.getByRole("textbox", { name: "独立请求快照" });
  const save = drawer.getByRole("button", { name: "保存", exact: true });
  const close = drawer.getByRole("button", { name: "关闭", exact: true });
  const cancel = drawer.getByRole("button", { name: "取消", exact: true });
  const scroll = drawer.locator(".interface-case-scroll");
  const bounds = async () => {
    const result = Object.fromEntries(
      await Promise.all(
        [
          ["drawer", drawer],
          ["header", drawer.locator("header")],
          ["close", close],
          ["title", drawer.locator("#dialog-title")],
          ["body", scroll],
          ["save", save],
        ].map(async ([key, item]) => [key, await item.boundingBox()]),
      ),
    );
    console.log("CASE_DRAWER_BOXES", JSON.stringify(result));
    return result;
  };
  const near = (value, expected, tolerance, metric) =>
    assert(
      Math.abs(value - expected) <= tolerance,
      metric + ": " + value + " not near " + expected,
    );
  const measure = async (width, height, expectedLeft) => {
    const boxes = await bounds();
    near(boxes.drawer.x, expectedLeft, 2, "left edge");
    near(boxes.drawer.x + boxes.drawer.width, width, 1, "right edge");
    assert.equal(boxes.drawer.y, 0);
    assert.equal(boxes.drawer.height, height);
    assert.equal(boxes.header.height, 46);
    assert(boxes.close.x < boxes.title.x);
    assert(boxes.save.y + boxes.save.height <= height);
    assert(boxes.body.y + boxes.body.height <= boxes.save.y);
    assert(
      await drawer.evaluate((node) => node.scrollHeight === node.clientHeight),
    );
    assert.equal(
      await drawer.getByRole("button", { name: /^(发送|运行用例)$/ }).count(),
      0,
    );
    return boxes;
  };

  await page.goto(app.launchUrl);
  await selectSource(original);
  await page.locator(".case-empty-layout").waitFor();
  assert.equal(await edit.count(), 0);
  await create.press("Enter");
  await drawer.getByText("新建接口用例", { exact: true }).waitFor();
  assert(await active(name));
  assert.equal(await name.inputValue(), "新用例");
  assert.equal(JSON.parse(await json.inputValue()).url, original.url);
  assert.equal(await folder.locator("option").count(), 1);
  const createBoxes = await measure(1363, 1023, 545);
  await capture("create-uncommitted");
  await name.fill("unsaved temporary name");
  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "hidden" });
  assert(await active(create));
  await create.press("Enter");
  assert.equal(await name.inputValue(), "新用例");
  await close.press("Enter");
  await drawer.waitFor({ state: "hidden" });
  assert(await active(create));

  await selectSource(populated);
  await edit.waitFor();
  await edit.press("Enter");
  await drawer.getByText("编辑接口用例", { exact: true }).waitFor();
  assert(await active(name));
  assert.equal(await name.inputValue(), baseline.cases[0].name);
  assert.equal(await folder.inputValue(), baseline.cases[0].folderId);
  assert.deepEqual(
    JSON.parse(await json.inputValue()),
    baseline.cases[0].request,
  );
  const editBoxes = await measure(1363, 1023, 545);
  await capture("edit-uncommitted");

  await page.setViewportSize({ width: 430, height: 720 });
  await measure(430, 720, 0);
  await json.fill("{");
  await save.press("Enter");
  const alert = drawer.getByRole("alert");
  await alert.waitFor();
  assert((await alert.textContent()).length > 0);
  assert(await drawer.isVisible());
  assert(await save.isEnabled());
  assert.equal(await json.inputValue(), "{");
  await cancel.press("Enter");
  await drawer.waitFor({ state: "hidden" });
  assert(await active(edit));
  await edit.press("Enter");
  assert.deepEqual(
    JSON.parse(await json.inputValue()),
    baseline.cases[0].request,
  );
  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "hidden" });

  await page.setViewportSize({ width: 1363, height: 1023 });
  await page.locator("#new-case-folder").press("Enter");
  await drawer.getByText("新建用例分组", { exact: true }).waitFor();
  assert.equal(await drawer.locator(".interface-case-editor").count(), 0);
  assert((await drawer.boundingBox()).width < 818);
  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "hidden" });
  assert.deepEqual(await app.store.get(project.id), baseline);
  assert.deepEqual(await page.evaluate(() => window.__caseDrawerCSP), []);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  if (evidence)
    await writeFile(
      join(evidence, "case-drawer-metrics.json"),
      JSON.stringify({ create: createBoxes, edit: editBoxes }, null, 2) + "\n",
    );
  console.log(
    "INTERFACE_CASE_DRAWER_UI_PASS create/edit/geometry/narrow/focus/zero-writes",
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
