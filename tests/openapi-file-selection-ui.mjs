import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const evidence = process.env.OPENAPI_FILE_SELECTION_EVIDENCE;
const root = await mkdtemp(join(tmpdir(), "workbench-openapi-selection-ui-"));
let app, browser, release;
try {
  app = await createApp({ root, port: 0 });
  const project = await app.store.create("默认项目");
  const baseline = await app.store.get(project.id);
  const origin = new URL(app.launchUrl).origin;
  const endpoint = "/api/projects/" + project.id;
  const traces = [],
    blocked = [],
    errors = [];
  let applied = false,
    permitApply = false,
    holdNext,
    delayed;
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
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("theme", "light");
    window.__subsetReads = 0;
    const read = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () {
      if (this instanceof File) window.__subsetReads++;
      return read.call(this);
    };
  });
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin === origin && req.method() === "GET")
      return route.continue();
    if (url.origin === origin && req.method() === "POST") {
      if (url.pathname === endpoint + "/import-preview") {
        const input = req.postDataJSON();
        const response = await route.fetch();
        const { token } = await response.json();
        traces.push({ kind: "preview", input, token });
        if (holdNext) {
          holdNext = false;
          delayed();
          await new Promise((resolve) => {
            release = resolve;
          });
        }
        return route.fulfill({ response });
      }
      if (
        url.pathname === endpoint + "/import-apply" &&
        permitApply &&
        !applied
      ) {
        applied = true;
        traces.push({ kind: "apply", ...req.postDataJSON() });
        return route.continue();
      }
    }
    blocked.push([req.method(), url.pathname]);
    return route.abort();
  });

  const standaloneFixture = (paths) =>
    JSON.stringify(
      {
        openapi: "3.0.3",
        info: { title: "Local owner selection", version: "1" },
        paths,
      },
      null,
      2,
    ) + "\n";
  const getter = (summary) => ({
    get: {
      summary,
      responses: { 200: { description: "Synthetic response definition only" } },
    },
  });
  const one = standaloneFixture({
    "/visual-import-ping": getter("Visual import ping"),
  });
  const two = standaloneFixture({
    "/z-last": getter("Z getter"),
    "/a-first": getter("A getter"),
  });
  const entry = page.locator(".settings-nav #import");
  const input = page.getByRole("dialog", { name: "导入项目（手动）" });
  const preview = page.getByRole("dialog", { name: "预览 Swagger / OpenAPI" });
  const confirm = preview.getByRole("button", { name: "确认导入" });
  const refresh = preview.getByRole("button", { name: "更新预览" });
  const all = preview.getByRole("checkbox", { name: "全选接口" });
  const count = preview.locator("#openapi-review-count");
  const reads = () => page.evaluate(() => window.__subsetReads);
  const open = async (text) => {
    await entry.press("Enter");
    await input.locator("#import-file").setInputFiles({
      name: "verification-openapi.json",
      mimeType: "application/json",
      buffer: Buffer.from(text),
    });
    await input.getByRole("button", { name: "预览 Swagger / OpenAPI" }).click();
    await preview.waitFor();
  };
  const capture = async (state) => {
    if (!evidence) return;
    await mkdir(evidence, { recursive: true });
    await page.screenshot({
      path: join(evidence, "native-comparable-" + state + ".png"),
      clip: { x: 0, y: 0, width: 1363, height: 980 },
      caret: "hide",
      animations: "disabled",
    });
  };

  await page.goto(app.launchUrl);
  await page.locator('.rail [data-page="settings"]').click();
  await open(one);
  assert(
    await preview
      .getByRole("checkbox", { name: /Visual import ping/ })
      .isChecked(),
  );
  assert(await confirm.isEnabled());
  await capture("one-checked");
  await all.press("Space");
  assert.equal(await count.textContent(), "接口（0/1）");
  assert(await confirm.isDisabled());
  assert(await refresh.isDisabled());
  assert.equal(traces.length, 1);
  await capture("one-unchecked");
  await page.keyboard.press("Escape");
  await preview.waitFor({ state: "hidden" });
  assert.deepEqual(await app.store.get(project.id), baseline);

  await open(two);
  const a = preview.getByRole("checkbox", { name: /A getter/ });
  const z = preview.getByRole("checkbox", { name: /Z getter/ });
  assert(await a.isChecked());
  assert(await z.isChecked());
  assert.equal(await a.getAttribute("value"), "api:requests/0");
  assert.equal(await z.getAttribute("value"), "api:requests/1");
  await z.press("Space");
  assert.equal(await count.textContent(), "接口（1/2）");
  assert(await all.evaluate((node) => node.indeterminate));
  assert(await confirm.isDisabled());

  holdNext = true;
  const received = new Promise((resolve) => {
    delayed = resolve;
  });
  await refresh.click();
  await received;
  await a.press("Space");
  await z.press("Space");
  release();
  release = undefined;
  await preview
    .locator("#openapi-review-selection-status")
    .getByText("选择已变化，更新预览后才能确认。")
    .waitFor();
  assert(await confirm.isDisabled());
  assert.equal(await reads(), 2);
  assert.deepEqual(await app.store.get(project.id), baseline);

  await z.press("Space");
  await a.press("Space");
  await refresh.click();
  await preview
    .locator("#openapi-review-selection-status")
    .getByText(/预览已更新/)
    .waitFor();
  assert(await confirm.isEnabled());
  assert.equal(await count.textContent(), "接口（1/2）");
  assert.equal(
    await preview
      .locator('[data-openapi-review-action="api:requests/1"]')
      .textContent(),
    "未选",
  );
  assert.equal(await reads(), 2);
  assert.deepEqual(await app.store.get(project.id), baseline);
  await capture("two-subset");

  permitApply = true;
  await confirm.press("Enter");
  await preview.waitFor({ state: "hidden" });
  assert.equal(
    await reads(),
    2,
    "apply and all refreshes reused the frozen file",
  );
  assert.deepEqual(
    traces.map(({ kind }) => kind),
    ["preview", "preview", "preview", "preview", "apply"],
  );
  const final = traces.at(-1);
  assert.equal(final.token, traces.at(-2).token);
  assert.notEqual(final.token, traces.at(-4).token);
  assert.equal(final.input.document, two);
  assert.deepEqual(final.input.selection, {
    mode: "explicit",
    keys: ["api:requests/0"],
  });
  const saved = await app.store.get(project.id);
  assert.equal(saved.configRevision, baseline.configRevision + 1);
  assert.deepEqual(
    saved.requests.map(({ name }) => name),
    ["A getter"],
  );
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  if (evidence)
    await writeFile(
      join(evidence, "subset-metrics.json"),
      JSON.stringify(
        {
          reads: await reads(),
          requests: traces.map(({ kind, input }) => ({
            kind,
            scope: input.selection,
          })),
        },
        null,
        2,
      ) + "\n",
    );
  console.log(
    "OPENAPI_FILE_SELECTION_UI_PASS native one-row states plus exact owned two-operation subset",
  );
} finally {
  release?.();
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
