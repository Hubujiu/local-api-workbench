import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";
import { pickProjectUI } from "./helpers/pick-project-ui.mjs";
import { namedGraphQLExportFixture } from "./helpers/graphql-export-scope-fixture.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const home = await mkdtemp(join(tmpdir(), "workbench-named-export-ui-"));
let app, browser;
try {
  app = await createApp({ root: home, port: 0 });
  const create = async (name, requests) => {
    const owner = await app.store.create(name);
    owner.requests = requests;
    return app.store.save(owner);
  };
  const named = await create("Named synthetic export", [
    namedGraphQLExportFixture(),
  ]);
  const plain = await create("Ordinary synthetic export", [
    normalizeRequest({
      id: "ordinary",
      name: "Ordinary HTTP JSON",
      method: "POST",
      url: "http://127.0.0.1:1/ordinary",
      bodyType: "json",
      body: '{"query":"ambiguous ordinary JSON"}',
    }),
    namedGraphQLExportFixture({ deletedAt: "2026-11-22T00:00:00.000Z" }),
  ]);
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
  await page.addInitScript((id) => {
    sessionStorage.setItem("project", id);
    localStorage.setItem("theme", "light");
  }, named.id);
  const origin = new URL(app.launchUrl).origin;
  const blocked = [],
    errors = [],
    downloads = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("download", (d) => downloads.push(d.suggestedFilename()));
  await page.route("**/*", (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (
      url.origin === origin &&
      req.method() === "GET" &&
      !url.pathname.endsWith("/export")
    )
      return route.continue();
    blocked.push([req.method(), url.pathname]);
    return route.abort();
  });
  await page.goto(app.launchUrl);
  const open = () => page.locator("#export").click();
  const dialog = page.locator("#dialog");
  const format = dialog.locator("#export-format");
  const note = dialog.locator("#graphql-openapi-export-note");
  const secret = dialog.getByText(/可能包含密钥、请求凭据和响应数据/);
  const evidence = process.env.GRAPHQL_EXPORT_NOTICE_EVIDENCE;
  const capture = async (state) => {
    if (!evidence) return;
    await mkdir(evidence, { recursive: true });
    await page.screenshot({
      path: join(evidence, state + ".png"),
      caret: "hide",
      animations: "disabled",
    });
  };
  const close = async () => {
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
  };
  await open();
  assert.equal(await format.inputValue(), "native");
  assert.equal(await note.isVisible(), false);
  assert.equal(await format.getAttribute("aria-describedby"), null);
  assert.equal(await secret.isVisible(), true);
  await format.selectOption("openapi");
  assert.equal(await note.isVisible(), true);
  assert.equal(
    await format.getAttribute("aria-describedby"),
    "graphql-openapi-export-note",
  );
  assert.match(
    await note.innerText(),
    /只导出当前活动查询.*无法精确表示的数字.*本地项目 JSON/,
  );
  assert.doesNotMatch(
    await note.innerText(),
    /900719925|ActiveFixture|InactiveFixture/,
  );
  assert.equal(await secret.isVisible(), true);
  await capture("openapi-named-desktop");
  await page.setViewportSize({ width: 430, height: 830 });
  const box = await dialog.boundingBox();
  assert(box.x >= 0 && box.x + box.width <= 430, JSON.stringify(box));
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  await capture("openapi-named-narrow");
  await format.selectOption("native");
  assert.equal(await note.isVisible(), false);
  assert.equal(await format.getAttribute("aria-describedby"), null);
  await close();

  await page.setViewportSize({ width: 1363, height: 1023 });
  await pickProjectUI(page, plain.id);
  await open();
  await format.selectOption("openapi");
  assert.equal(
    await note.count(),
    0,
    "ordinary JSON and archived variants do not show this notice",
  );
  assert.equal(await secret.isVisible(), true);
  await close();
  assert.deepEqual(await app.store.get(named.id), named);
  assert.deepEqual(await app.store.get(plain.id), plain);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(downloads, []);
  console.log(
    "GRAPHQL_EXPORT_NOTICE_UI_PASS actual-scope/format/accessible-warning/no-writes/no-downloads/1363+430",
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(home, { recursive: true, force: true });
}
