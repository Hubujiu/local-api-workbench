import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const root = await mkdtemp(join(tmpdir(), "workbench-empty-trash-"));
let app, browser;
try {
  app = await createApp({ root, port: 0 });
  const project = await app.store.create("默认项目");
  project.requests.push(
    normalizeRequest({
      id: "verification",
      name: "Verification",
      url: "http://127.0.0.1:1/verification",
    }),
  );
  await app.store.save(project);
  const baseline = await app.store.get(project.id);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const origin = new URL(app.launchUrl).origin;
  const blocked = [],
    errors = [],
    reads = [],
    metrics = {};
  async function start(id) {
    const page = await browser.newPage({
      viewport: { width: 1363, height: 1023 },
      deviceScaleFactor: 1,
      locale: "zh-CN",
    });
    page.setDefaultTimeout(7500);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((id) => {
      localStorage.setItem("theme", "light");
      sessionStorage.setItem("project", id);
    }, id);
    await page.route("**/*", async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      if (url.origin !== origin || req.method() !== "GET") {
        blocked.push([req.method(), url.pathname]);
        return route.abort();
      }
      if (url.pathname.startsWith("/api/projects")) reads.push(url.pathname);
      return route.continue();
    });
    await page.goto(app.launchUrl);
    return page;
  }
  const page = await start(project.id);
  const trash = page.locator('.rail [data-page="trash"]');
  const history = page.locator('.rail [data-page="history"]');
  const historyReload = page.locator("#history-project-reload");
  const dialog = page.locator("#empty-trash-dialog");
  const close = dialog.getByRole("button", { name: "关闭", exact: true });
  const prefix = process.env.EMPTY_TRASH_CAPTURE_PREFIX;
  const capture = async (state) => {
    metrics[state] = await dialog.boundingBox();
    if (!prefix) return;
    await page.mouse.move(800, 86);
    await page.screenshot({
      path: `${prefix}-${state}.png`,
      ...(state === "desktop"
        ? { clip: { x: 0, y: 0, width: 1363, height: 980 } }
        : {}),
      caret: "hide",
      animations: "disabled",
    });
  };
  await history.click();
  await historyReload.waitFor();
  const originalReads = [...reads];
  await trash.click();
  await dialog.getByText("暂无可在此恢复的接口或归档项目").waitFor();
  assert.equal(await history.getAttribute("aria-current"), "page");
  assert.equal(await dialog.getByRole("button").count(), 1);
  await capture("desktop");
  console.log("Trash geometry", JSON.stringify(metrics.desktop));
  assert.deepEqual(metrics.desktop, {
    x: 281.5,
    y: 282,
    width: 800,
    height: 459,
  });
  await close.click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await historyReload.isVisible(), true);
  assert.equal(
    await trash.evaluate((node) => node === document.activeElement),
    true,
  );
  assert.deepEqual(reads, originalReads);
  await trash.press("Enter");
  await close.waitFor();
  await page.setViewportSize({ width: 430, height: 740 });
  await capture("narrow");
  assert.equal(metrics.narrow.width, 406);
  assert.equal(
    await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
    true,
  );
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 1363, height: 1023 });
  await page.locator('.rail [data-page="apis"]').click();
  await page.locator("#request-name").fill("Unsaved synthetic draft");
  await trash.press("Enter");
  assert.equal(
    await close.evaluate((node) => node === document.activeElement),
    true,
  );
  await page.keyboard.press("Control+s");
  await page.keyboard.press("Control+Enter");
  assert.equal(await dialog.isVisible(), true);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(
    await page.locator("#request-name").inputValue(),
    "Unsaved synthetic draft",
  );
  assert.match(await page.locator("#saved-state").innerText(), /未保存/);
  assert.deepEqual(reads, originalReads);
  assert.deepEqual(await app.store.get(project.id), baseline);

  // Pre-seed independent legitimate records; the browser never restores or deletes them.
  const second = await app.store.create("Synthetic legacy rows");
  const archived = await app.store.create("Archived synthetic project");
  second.requests.push({
    ...normalizeRequest({
      id: "soft-deleted",
      name: "Soft-deleted synthetic request",
    }),
    deletedAt: "2026-11-21T04:00:00.000Z",
  });
  archived.archived = true;
  await app.store.save(second);
  await app.store.save(archived);
  const prior = await Promise.all(
    [second, archived].map(({ id }) => app.store.get(id)),
  );
  const other = await start(second.id);
  await other.locator('.rail [data-page="trash"]').click();
  assert.equal(await other.locator("#empty-trash-dialog").isVisible(), false);
  const existing = other.locator(".workspace > .page");
  await existing.getByRole("heading", { name: "回收站" }).waitFor();
  assert.equal(
    await existing.locator('[data-restore="soft-deleted"]').innerText(),
    "恢复",
  );
  assert.equal(await existing.locator("[data-restore-project]").count(), 1);
  await existing
    .getByText("Soft-deleted synthetic request", { exact: true })
    .waitFor();
  await existing
    .getByText("归档项目 · Archived synthetic project", { exact: true })
    .waitFor();
  if (prefix)
    await other.screenshot({
      path: prefix + "-legacy-populated.png",
      clip: { x: 0, y: 0, width: 1363, height: 980 },
      animations: "disabled",
    });

  assert.deepEqual(
    await Promise.all([second, archived].map(({ id }) => app.store.get(id))),
    prior,
  );
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  if (prefix)
    await writeFile(
      prefix + ".json",
      JSON.stringify({ metrics, errors, blocked }, null, 2) + "\n",
    );
  console.log(
    "EMPTY_TRASH_UI_PASS history-overlay/keyboard/430/draft/no-project-read-or-write/legacy-restore-controls",
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
