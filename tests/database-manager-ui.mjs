import { pickProjectUI } from "./helpers/pick-project-ui.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const root = await mkdtemp(join(tmpdir(), "database-manager-ui-"));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
let app, browser, heldGate;
try {
  app = await createApp({ root, port: 0 });
  const first = await app.store.create("默认项目");
  const second = await app.store.create("另一个合成项目");
  const baseline = await Promise.all(
    [first, second].map(({ id }) => app.store.get(id)),
  );
  const firstPath = "/api/projects/" + first.id + "/database-connections";
  const secondPath = "/api/projects/" + second.id + "/database-connections";
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
    locale: "zh-CN",
  });
  page.setDefaultTimeout(7500);
  const origin = new URL(app.launchUrl).origin;
  const blocked = [],
    errors = [],
    reads = [],
    downloads = [],
    metrics = {};
  let held, fail;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("download", (download) =>
    downloads.push(download.suggestedFilename()),
  );
  await page.addInitScript((id) => {
    localStorage.setItem("theme", "light");
    sessionStorage.setItem("project", id);
  }, first.id);
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (
      url.origin !== origin ||
      req.method() !== "GET" ||
      url.pathname.endsWith("/database")
    ) {
      blocked.push([req.method(), url.pathname]);
      return route.abort();
    }
    if ([firstPath, secondPath].includes(url.pathname))
      reads.push(url.pathname);
    if (held && held.path === url.pathname) {
      const gate = held;
      held = null;
      try {
        const actual = await route.fetch();
        assert.equal(actual.status(), 200);
        assert.deepEqual(await actual.json(), []);
        gate.ready.resolve();
        await gate.release.promise;
        // Simulates only an old response completing, not a grant or a database query.
        await route.fulfill({
          response: actual,
          json: [{ name: "stale-synthetic-projection", type: "sqlite" }],
        });
        gate.done.resolve();
      } catch (error) {
        gate.ready.reject(error);
        gate.done.reject(error);
        await route.abort().catch(() => {});
      }
      return;
    }
    if (fail === url.pathname) {
      fail = null;
      return route.fulfill({
        status: 503,
        json: { error: "synthetic-backend-detail-not-rendered" },
      });
    }
    return route.continue();
  });
  const makeHold = (path) => {
    heldGate = {
      path,
      ready: deferred(),
      release: deferred(),
      done: deferred(),
    };
    heldGate.done.promise.catch(() => {});
    held = heldGate;
    return heldGate;
  };
  await page.goto(app.launchUrl);
  await page.locator('.rail [data-page="dictionary"]').click();
  const shortcut = page.locator(
    '.dictionary-side-nav [data-page="database-manager"]',
  );
  await shortcut.press("Enter");
  const manager = page.locator(".database-manager");
  const busy = manager.locator(".database-manager-table");
  const message = manager.locator("[data-db-manager-status]");
  const empty = manager.locator(".database-manager-empty");
  const refresh = manager.locator("#db-manager-refresh");
  const heading = manager.locator("#database-manager-heading");
  await empty.waitFor();
  assert.deepEqual(reads, [firstPath]);
  assert.equal(
    await heading.evaluate((node) => document.activeElement === node),
    true,
  );
  assert.equal(await shortcut.getAttribute("aria-current"), "page");
  assert.equal(
    await page
      .locator('.rail [data-page="dictionary"]')
      .getAttribute("aria-current"),
    "page",
  );
  assert.equal(await busy.getAttribute("aria-busy"), "false");
  assert.deepEqual(await manager.getByRole("columnheader").allTextContents(), [
    "名称",
    "数据库类型",
    "授权范围",
    "有效期",
  ]);
  assert.equal(await manager.locator("tbody tr").count(), 0);
  const prefix = process.env.DATABASE_MANAGER_CAPTURE_PREFIX;
  const capture = async (mode) => {
    metrics[mode] = await busy.boundingBox();
    if (!prefix) return;
    await page.evaluate(() => document.activeElement?.blur());
    await page.screenshot({
      path: `${prefix}-${mode}.png`,
      caret: "hide",
      ...(mode === "desktop"
        ? { clip: { x: 0, y: 0, width: 1363, height: 980 } }
        : {}),
      animations: "disabled",
    });
  };
  await capture("desktop");
  console.log("DATABASE_MANAGER desktop", JSON.stringify(metrics.desktop));
  assert.deepEqual(
    [
      metrics.desktop.x,
      metrics.desktop.y,
      metrics.desktop.width,
      Math.round(metrics.desktop.height),
    ],
    [384, 138, 959, 202],
    JSON.stringify(metrics.desktop),
  );

  const pending = makeHold(firstPath);
  await refresh.click();
  await pending.ready.promise;
  assert.equal(await busy.getAttribute("aria-busy"), "true");
  assert.equal(await message.innerText(), "正在读取会话授权");
  assert.equal(await empty.isVisible(), false);
  await pickProjectUI(page, second.id);
  await page.locator('.rail [data-page="dictionary"]').click();
  await shortcut.press("Enter");
  await empty.waitFor();
  assert.equal(await busy.getAttribute("aria-busy"), "false");
  pending.release.resolve();
  await pending.done.promise;
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.equal(
    await manager.getByText("stale-synthetic-projection").count(),
    0,
  );
  assert.equal(await empty.isVisible(), true);
  assert.deepEqual(reads, [firstPath, firstPath, secondPath]);

  fail = secondPath;
  await refresh.click();
  await manager
    .getByText("无法读取会话授权，请重试。", { exact: true })
    .waitFor();
  assert.equal(await empty.isVisible(), false);
  assert.equal(await busy.getAttribute("aria-busy"), "false");
  assert.equal(
    await page.getByText("synthetic-backend-detail-not-rendered").count(),
    0,
  );
  await refresh.press("Enter");
  await empty.waitFor();
  await page.setViewportSize({ width: 430, height: 840 });
  await capture("narrow");
  const narrow = metrics.narrow;
  assert(
    narrow && narrow.x >= 0 && narrow.x + narrow.width <= 430,
    JSON.stringify(narrow),
  );
  assert.equal(
    await manager.evaluate((node) => node.scrollWidth <= node.clientWidth),
    true,
  );
  await manager.locator("#db-manager-configure").press("Enter");
  await page.locator("#db-type").waitFor();
  assert.equal(await page.locator("#db-password").inputValue(), "");
  await page
    .getByRole("button", { name: "数据库管理", exact: true })
    .press("Enter");
  await empty.waitFor();
  await manager
    .getByRole("button", { name: "返回字典", exact: true })
    .press("Enter");
  await page.locator("#dictionary-surface-heading").waitFor();
  assert.deepEqual(
    await Promise.all([first, second].map(({ id }) => app.store.get(id))),
    baseline,
  );
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(downloads, []);
  if (prefix)
    await writeFile(
      prefix + ".json",
      JSON.stringify({ metrics, reads, blocked, errors, downloads }, null, 2) +
        "\n",
    );
  console.log(
    "DATABASE_MANAGER_UI_PASS owner-read/loading/error/empty/late-owner/desktop/narrow/no-query-or-write",
  );
} finally {
  heldGate?.release.resolve();
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
