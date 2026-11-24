import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const evidence = process.env.LOCAL_IMPORT_EVIDENCE;
const root = await mkdtemp(join(tmpdir(), "workbench-local-import-ui-"));
let app, browser;
try {
  app = await createApp({ root: join(root, "projects"), port: 0 });
  const owner = await app.store.create("默认项目");
  const baseline = await app.store.get(owner.id);
  const nativeFixture = join(root, "directory-fixture");
  await mkdir(nativeFixture);
  await writeFile(join(nativeFixture, "project.json"), '{"name":"Synthetic"}');
  if (evidence) await mkdir(evidence, { recursive: true });

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
  const blocked = [],
    errors = [];
  await page.addInitScript(() => {
    localStorage.setItem("theme", "light");
    window.__localImportReads = [];
    window.__localImportCSP = [];
    for (const [prototype, methods] of [
      [Blob.prototype, ["text", "arrayBuffer", "stream", "bytes"]],
      [
        FileReader.prototype,
        [
          "readAsText",
          "readAsArrayBuffer",
          "readAsDataURL",
          "readAsBinaryString",
        ],
      ],
    ])
      for (const method of methods) {
        const original = prototype[method];
        if (typeof original !== "function") continue;
        prototype[method] = function (...args) {
          if (this instanceof File || args[0] instanceof File)
            window.__localImportReads.push(method);
          return original.apply(this, args);
        };
      }
    window.addEventListener("securitypolicyviolation", (event) =>
      window.__localImportCSP.push({
        directive: event.effectiveDirective,
        blockedURI: event.blockedURI,
        source: event.sourceFile,
        line: event.lineNumber,
      }),
    );
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin && request.method() === "GET")
      return route.continue();
    blocked.push([request.method(), url.pathname]);
    return route.abort();
  });
  const capture = (state) =>
    evidence &&
    page.screenshot({
      path: join(evidence, "local-import-" + state + ".png"),
      clip: { x: 0, y: 0, width: 1363, height: 980 },
      caret: "hide",
      animations: "disabled",
    });
  const dialog = page.getByRole("dialog", { name: "导入项目（手动）" });
  const entry = page.locator(".settings-nav #import");
  const mode = dialog.locator("#import-mode");
  const current = dialog.getByRole("radio", { name: /本地定义文件/ });
  const restore = dialog.getByRole("radio", { name: /Workbench 备份/ });
  const directoryMode = dialog.getByRole("radio", { name: /Apipost 原版目录/ });
  const destination = dialog.locator("#local-import-destination");
  const text = dialog.locator("#import-text");
  const cancel = dialog.getByRole("button", { name: "取消", exact: true });
  const primary = dialog.getByRole("button", { name: "导入", exact: true });
  const dropArea = dialog.locator(".local-import-chooser:visible");
  const file = dialog.locator("#import-file");
  const directory = dialog.locator("#import-directory");
  const active = (locator) =>
    locator.evaluate((node) => document.activeElement === node);
  const bounds = async () => {
    const boxes = Object.fromEntries(
      await Promise.all(
        [
          ["dialog", dialog],
          ["dropArea", dropArea],
          ["action", primary],
        ].map(async ([name, element]) => [name, await element.boundingBox()]),
      ),
    );
    boxes.cards = await dialog
      .locator(".local-import-mode-card")
      .evaluateAll((cards) =>
        cards.map((card) => {
          const { x, y, width, height } = card.getBoundingClientRect();
          const metrics = (element) => {
            const target = card.querySelector(element);
            return {
              width: target.clientWidth,
              textWidth: target.scrollWidth,
              height: target.clientHeight,
              wraps: getComputedStyle(target).whiteSpace === "normal",
            };
          };
          return {
            x,
            y,
            width,
            height,
            title: metrics("strong"),
            hint: metrics("small"),
          };
        }),
      );
    console.log("LOCAL_IMPORT_BOXES", JSON.stringify(boxes));
    return boxes;
  };

  await page.goto(app.launchUrl);
  await page.locator('.rail [data-page="settings"]').click();
  await entry.press("Enter");
  assert(await active(current));
  assert(await current.isChecked());
  assert.equal(await mode.inputValue(), "interfaces");
  assert.equal(await dialog.getByRole("radio").count(), 3);
  assert.equal(await destination.textContent(), "导入当前项目");
  assert(await file.isVisible());
  assert(await directory.isHidden());
  const desktop = await bounds();
  await capture("default");
  assert.deepEqual(
    desktop.cards.map(({ width, height }) => [width, height]),
    [
      [178, 52],
      [178, 52],
      [178, 52],
    ],
  );
  for (const card of desktop.cards) {
    assert(card.title.height + card.hint.height <= card.height - 10);
  }
  assert.equal(desktop.dropArea.width, 972);
  assert.equal(desktop.dropArea.height, 219);

  // The actual label opens the real picker; Playwright supplies selected files.
  const chooserHandling = page.waitForEvent("filechooser");
  await dropArea.locator("strong").click();
  const chooser = await chooserHandling;
  const specification = JSON.stringify({
    swagger: "2.0",
    info: { title: "fixture", version: "1" },
    paths: {
      "/verification": { get: { responses: { 200: { description: "ok" } } } },
    },
  });
  await chooser.setFiles({
    name: "synthetic-swagger.json",
    mimeType: "application/json",
    buffer: Buffer.from(specification),
  });
  await dialog.getByText("synthetic-swagger.json", { exact: true }).waitFor();
  await text.fill("curl https://example.test/never-execute");
  assert.equal(
    await text.inputValue(),
    "curl https://example.test/never-execute",
  );

  await current.press("ArrowRight");
  assert(await active(restore));
  assert(await restore.isChecked());
  assert.equal(await mode.inputValue(), "restore");
  assert.equal(await destination.textContent(), "恢复为新的项目副本");
  assert.equal(await file.getAttribute("accept"), ".json");
  assert.equal(await text.getAttribute("placeholder"), "粘贴备份 JSON");

  // Existing automation uses the actual select. Both routes stay in sync.
  await mode.selectOption("apipost-directory");
  assert(await directoryMode.isChecked());
  assert.equal(await destination.textContent(), "导入当前项目（原版目录子集）");
  assert(await file.isHidden());
  assert(await text.isHidden());
  await directory.setInputFiles(nativeFixture);
  await dialog.getByText("已选择 1 个文件", { exact: true }).waitFor();
  await capture("directory");

  await current.check();
  assert.equal(await mode.inputValue(), "interfaces");
  assert.equal(
    await text.inputValue(),
    "curl https://example.test/never-execute",
  );
  await dialog.getByText("synthetic-swagger.json", { exact: true }).waitFor();
  await page.setViewportSize({ width: 430, height: 720 });
  const narrow = await bounds();
  assert(narrow.cards.every((card) => card.title.wraps && card.hint.wraps));
  assert(narrow.dialog.x >= 0 && narrow.dialog.x + narrow.dialog.width <= 430);
  assert(narrow.action.y + narrow.action.height <= 720);
  assert.equal(
    await dialog.evaluate((node) => node.scrollWidth - node.clientWidth),
    0,
  );
  await cancel.press("Enter");
  await dialog.waitFor({ state: "hidden" });
  assert(await active(entry));
  await entry.press("Enter");
  assert(await current.isChecked());
  assert.equal(await file.evaluate((node) => node.files.length), 0);
  assert.equal(await text.inputValue(), "");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert(await active(entry));

  await page.setViewportSize({ width: 1363, height: 1023 });
  await page.locator('.rail [data-page="apis"]').click();
  const apiEntry = page.locator(".sidebar #import");
  await apiEntry.press("Enter");
  assert(await dialog.isVisible());
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(await page.evaluate(() => window.__localImportReads), []);
  assert.deepEqual(await page.evaluate(() => window.__localImportCSP), []);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(await app.store.get(owner.id), baseline);
  if (evidence)
    await writeFile(
      join(evidence, "local-import-metrics.json"),
      JSON.stringify({ desktop, narrow }, null, 2) + "\n",
    );
  console.log(
    "LOCAL_PROJECT_IMPORT_UI_PASS genuine modes/picker/directory/narrow/zero reads or writes",
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
