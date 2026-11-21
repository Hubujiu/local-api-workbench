import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";
import {
  checkUnsentResponseData,
  exerciseHTTPResponseTabs,
} from "./helpers/http-response-tabs-ui.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || "playwright");
const root = await mkdtemp(join(tmpdir(), "workbench-unsent-response-"));
let app, browser;
try {
  app = await createApp({ root, port: 0 });
  const project = await app.store.create("默认项目");
  const url = "http://127.0.0.1:38982/verification";
  project.requests.push(
    normalizeRequest({ id: "verification", name: "Verification", url }),
  );
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
  page.setDefaultTimeout(6500);
  const blocked = [],
    errors = [],
    metrics = {};
  const origin = new URL(app.launchUrl).origin;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("theme", "light"));
  await page.route("**/*", (route) => {
    const req = route.request();
    if (req.method() === "GET" && new URL(req.url()).origin === origin)
      return route.continue();
    blocked.push([req.method(), new URL(req.url()).origin === origin]);
    return route.abort();
  });
  await page.goto(app.launchUrl);
  const editor = page.locator('.editor[data-editor-mode="debug"]');
  await editor.locator('.param-tabs [data-param="body"]').click();
  await editor.locator(".body-none").waitFor();
  assert.equal(await editor.locator("#url").inputValue(), url);
  const prefix = process.env.RESPONSE_EMPTY_CAPTURE_PREFIX;
  for (const name of ["body", "headers", "cookies"]) {
    const tab = editor.locator(`.response-tabs [data-response="${name}"]`);
    await tab.click();
    assert.equal(await tab.getAttribute("aria-pressed"), "true");
    const panel = editor.locator(".response-body");
    if (name === "body") {
      await panel
        .getByText("输入 URL 后点击发送获取响应结果", { exact: true })
        .waitFor();
      assert.equal(await panel.locator("[data-unsent-response]").count(), 0);
      metrics.body = await panel.locator(".http-response-empty").boundingBox();
    } else {
      const box = await checkUnsentResponseData(page, name, false);
      const expectedHeight = name === "headers" ? 180 : 217;
      assert.equal(Math.round(box.x), 371, JSON.stringify(box));
      assert.equal(Math.round(box.y), 639, JSON.stringify(box));
      assert.equal(Math.round(box.width), 976, JSON.stringify(box));
      assert.ok(
        Math.abs(box.height - expectedHeight) <= 1,
        JSON.stringify(box),
      );
      metrics[name] = box;
    }
    if (prefix) {
      await page.mouse.move(800, 88);
      await page.evaluate(() => document.activeElement?.blur());
      await page.screenshot({
        path: `${prefix}-${name}.png`,
        clip: { x: 0, y: 0, width: 1363, height: 980 },
        caret: "hide",
        animations: "disabled",
      });
    }
  }
  await exerciseHTTPResponseTabs(page);
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  assert.deepEqual(await app.store.get(project.id), baseline);
  if (prefix)
    await writeFile(
      `${prefix}.json`,
      JSON.stringify({ metrics, blocked, errors }, null, 2) + "\n",
    );
  console.log(JSON.stringify(metrics));
  console.log(
    "HTTP_RESPONSE_EMPTY_UI_PASS body/header/cookie/narrow/split/no-dispatch",
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
