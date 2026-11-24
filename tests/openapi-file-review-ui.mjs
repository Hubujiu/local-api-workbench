import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const evidence = process.env.OPENAPI_FILE_REVIEW_EVIDENCE;
const root = await mkdtemp(join(tmpdir(), "workbench-openapi-review-ui-"));
let app, browser;
try {
  app = await createApp({ root, port: 0 });
  const owner = await app.store.create("默认项目");
  const baseline = await app.store.get(owner.id);
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
  page.setDefaultTimeout(9000);
  const origin = new URL(app.launchUrl).origin;
  const projectRoute = "/api/projects/" + owner.id;
  const requests = [],
    blocked = [],
    errors = [];
  let inFlight,
    holdNext,
    release,
    ready,
    permitApply = false;
  await page.addInitScript(() => {
    localStorage.setItem("theme", "light");
    window.__openAPIReviewReads = 0;
    const original = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () {
      if (this instanceof File) window.__openAPIReviewReads++;
      return original.call(this);
    };
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin === origin && req.method() === "GET")
      return route.continue();
    const preview = url.pathname === projectRoute + "/import-preview";
    const apply = url.pathname === projectRoute + "/import-apply";
    if (
      url.origin === origin &&
      req.method() === "POST" &&
      (preview || (apply && permitApply))
    ) {
      const data = req.postDataJSON();
      requests.push({ type: preview ? "preview" : "apply", data });
      if (preview && holdNext) {
        holdNext = false;
        const response = await route.fetch();
        ready();
        await inFlight;
        return route.fulfill({ response });
      }
      if (apply) permitApply = false;
      return route.continue();
    }
    blocked.push([req.method(), url.pathname]);
    return route.abort();
  });
  const entry = page.locator(".settings-nav #import");
  const inputDialog = page.getByRole("dialog", { name: "导入项目（手动）" });
  const review = page.getByRole("dialog", { name: "预览 Swagger / OpenAPI" });
  const confirm = review.getByRole("button", { name: "确认导入", exact: true });
  const preview = inputDialog.getByRole("button", {
    name: "预览 Swagger / OpenAPI",
  });
  const file = inputDialog.locator("#import-file");
  const document = (label, path) =>
    JSON.stringify(
      {
        openapi: "3.0.3",
        info: { title: "Workbench UI Import Verification", version: "1.0.0" },
        paths: {
          [path]: {
            get: {
              operationId: "visualImportPing",
              summary: label,
              responses: {
                200: { description: "Synthetic response definition only" },
              },
            },
          },
        },
      },
      null,
      2,
    ) + "\n";
  const exact = document("Visual import ping", "/visual-import-ping");
  const choose = (text = exact, name = "verification-openapi.json") =>
    file.setInputFiles({
      name,
      mimeType: "application/json",
      buffer: Buffer.from(text),
    });
  const reads = () => page.evaluate(() => window.__openAPIReviewReads);

  await page.goto(app.launchUrl);
  await page.locator('.rail [data-page="settings"]').click();
  await entry.press("Enter");
  assert(await preview.isHidden());
  await choose();
  assert(await preview.isVisible());
  assert.equal(await reads(), 0);
  assert.deepEqual(requests, []);
  await page.keyboard.press("Escape");
  await inputDialog.waitFor({ state: "hidden" });

  await entry.press("Enter");
  await choose();
  holdNext = true;
  inFlight = new Promise((resolve) => {
    release = resolve;
  });
  const delayed = new Promise((resolve) => {
    ready = resolve;
  });
  await preview.click();
  await delayed;
  await choose(document("Different file", "/other"), "different-openapi.json");
  release();
  await inputDialog
    .getByRole("status")
    .getByText(/所选文件或导入方式已变化/)
    .waitFor();
  assert(await review.isHidden());
  assert.equal(await reads(), 1);
  assert.deepEqual(
    requests.map((req) => req.type),
    ["preview"],
  );
  assert.deepEqual(await app.store.get(owner.id), baseline);

  await choose();
  await preview.click();
  await review
    .getByRole("list", { name: "计划导入资源" })
    .getByText("Visual import ping", { exact: true })
    .waitFor();
  assert(await confirm.isEnabled());
  assert.deepEqual(await app.store.get(owner.id), baseline);
  assert.equal(await reads(), 2);
  assert.deepEqual(
    requests.map((req) => req.type),
    ["preview", "preview"],
  );
  assert.deepEqual(requests.at(-1).data, {
    format: "openapi",
    document: exact,
    selection: { mode: "all" },
  });
  assert(await review.getByText("GET", { exact: true }).isVisible());
  assert.equal(await review.getByRole("checkbox").count(), 2);
  assert(await review.getByRole("checkbox", { name: "全选接口" }).isChecked());
  assert(
    await review
      .getByRole("checkbox", { name: /Visual import ping/ })
      .isChecked(),
  );
  const wide = await review.boundingBox();
  console.log("OPENAPI_FILE_REVIEW_BOX", JSON.stringify(wide));
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await page.screenshot({
      path: join(evidence, "openapi-file-review-panel.png"),
      clip: { x: 0, y: 0, width: 1363, height: 980 },
      caret: "hide",
      animations: "disabled",
    });
    await writeFile(
      join(evidence, "openapi-file-review-metrics.json"),
      JSON.stringify(wide, null, 2) + "\n",
    );
  }
  assert(Math.abs(wide.x - 272) <= 2);
  assert(Math.abs(wide.y - 100) <= 2);
  assert.equal(wide.width, 818);
  assert.equal(wide.height, 671);
  await page.setViewportSize({ width: 430, height: 720 });
  const narrow = await review.boundingBox();
  const saveBox = await confirm.boundingBox();
  assert(narrow.x >= 0 && narrow.x + narrow.width <= 430);
  assert(saveBox.y + saveBox.height <= 720);
  await page.keyboard.press("Escape");
  await review.waitFor({ state: "hidden" });
  assert.deepEqual(await app.store.get(owner.id), baseline);

  await page.setViewportSize({ width: 1363, height: 1023 });
  await entry.press("Enter");
  await choose();
  await preview.click();
  await confirm.waitFor();
  assert.equal(await reads(), 3);
  permitApply = true; // This explicit UI action is the fixture's only permitted write.
  await confirm.press("Enter");
  await review.waitFor({ state: "hidden" });
  assert.equal(
    await reads(),
    3,
    "confirmed import must use the same bytes, not re-read",
  );
  assert.deepEqual(
    requests.map((req) => req.type),
    ["preview", "preview", "preview", "apply"],
  );
  assert.deepEqual(requests.at(-1).data.input, requests.at(-2).data);
  assert.equal(typeof requests.at(-1).data.token, "string");
  const saved = await app.store.get(owner.id);
  assert.equal(saved.configRevision, baseline.configRevision + 1);
  const imported = saved.requests.filter(
    (request) => request.name === "Visual import ping",
  );
  assert.equal(imported.length, 1);
  await page.locator('.rail [data-page="apis"]').click();
  await page.locator('[data-request="' + imported[0].id + '"]').waitFor();
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  console.log(
    "OPENAPI_FILE_REVIEW_UI_PASS real preview/cancel/stale/exact bytes/explicit apply",
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
