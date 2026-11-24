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
const root = await mkdtemp(join(tmpdir(), "request-trash-confirmation-"));
let app, browser;
try {
  app = await createApp({ root, port: 0 });
  const project = await app.store.create("默认项目");
  const name = "Trash Visual Fixture",
    id = "trash-visual-fixture";
  for (const r of [
    { id, name, method: "POST", url: "http://127.0.0.1:1/disposable-trash" },
    {
      id: "verification",
      name: "Verification",
      method: "GET",
      url: "http://127.0.0.1:1/verification",
    },
  ])
    project.requests.push(normalizeRequest(r));
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
  });
  page.setDefaultTimeout(7500);
  const origin = new URL(app.launchUrl).origin;
  const endpoint = "/api/projects/" + project.id;
  const blocked = [],
    writes = [],
    errors = [],
    metrics = {};
  let expected;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("theme", "light"));
  await page.route("**/*", (r) => {
    const req = r.request(),
      url = new URL(req.url());
    if (url.origin === origin && req.method() === "GET") return r.continue();
    if (
      expected &&
      url.origin === origin &&
      url.pathname === endpoint &&
      req.method() === "PUT"
    ) {
      const tombstone = Boolean(
        req.postDataJSON().requests.find((request) => request.id === id)
          ?.deletedAt,
      );
      assert.equal(tombstone, expected === "move");
      writes.push(expected);
      expected = undefined;
      return r.continue();
    }
    blocked.push([req.method(), url.pathname]);
    return r.abort();
  });
  await page.goto(app.launchUrl);
  const opener = page.locator("#delete");
  const dialog = page.locator("#dialog");
  const cancel = dialog.getByRole("button", { name: "取消", exact: true });
  const confirm = dialog.getByRole("button", { name: "确定", exact: true });
  const row = page.locator(`[data-request="${id}"]`);
  const focus = (control) =>
    control.evaluate((node) => node === document.activeElement);
  const prefix = process.env.REQUEST_TRASH_CAPTURE_PREFIX;
  const capture = async (state) => {
    if (!prefix) return;
    await page.mouse.move(800, 88);
    await page.screenshot({
      path: `${prefix}-${state}.png`,
      caret: "hide",
      animations: "disabled",
      ...(state === "narrow"
        ? {}
        : { clip: { x: 0, y: 0, width: 1363, height: 980 } }),
    });
  };
  await opener.click();
  await dialog
    .getByText("确定将 " + name + " 移到回收站？", { exact: true })
    .waitFor();
  assert.equal(await focus(cancel), true);
  metrics.desktop = await dialog.boundingBox();
  console.log(
    "Request Trash confirmation geometry",
    JSON.stringify(metrics.desktop),
  );
  await capture("confirm");
  assert.deepEqual(metrics.desktop, {
    x: 473.5,
    y: 100,
    width: 416,
    height: 117,
  });
  await page.keyboard.press("Control+s");
  await page.keyboard.press("Control+Enter");
  assert.equal(await dialog.isVisible(), true);
  await cancel.click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await focus(opener), true);
  await row.waitFor();
  await capture("cancel");
  await opener.press("Enter");
  await dialog.waitFor();
  assert.equal(await focus(cancel), true);
  await page.setViewportSize({ width: 430, height: 760 });
  metrics.narrow = await dialog.boundingBox();
  assert(
    metrics.narrow.x >= 0 && metrics.narrow.x + metrics.narrow.width <= 430,
  );
  const confirmBox = await confirm.boundingBox();
  assert(confirmBox.x >= 0 && confirmBox.x + confirmBox.width <= 430);
  await capture("narrow");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 1363, height: 1023 });
  assert.equal(await focus(opener), true);
  assert.deepEqual(writes, []);
  assert.deepEqual(await app.store.get(project.id), baseline);

  // Proceed only after the preceding read-only screenshot and cancel lane passed.
  const getFixture = async () =>
    (await app.store.get(project.id)).requests.find(
      (request) => request.id === id,
    );
  const putReply = () =>
    page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === endpoint &&
        r.request().method() === "PUT" &&
        r.status() === 200,
    );
  await opener.click();
  await confirm.click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await row.count(), 0);
  assert.equal((await getFixture()).deletedAt, undefined);
  assert.deepEqual(writes, []);
  assert.match(await page.locator("#saved-state").innerText(), /未保存/);
  await page.locator('.rail [data-page="trash"]').click();
  const restore = page.locator(`[data-restore="${id}"]`);
  await restore.waitFor();
  expected = "move";
  await Promise.all([putReply(), page.locator("#save-project").click()]);
  await page
    .locator("#saved-state")
    .getByText("✓ 已保存", { exact: true })
    .waitFor();
  assert.equal(typeof (await getFixture()).deletedAt, "string");
  expected = "restore";
  await Promise.all([putReply(), restore.click()]);
  await page
    .locator("#saved-state")
    .getByText("✓ 已保存", { exact: true })
    .waitFor();
  assert.equal((await getFixture()).deletedAt, undefined);
  assert.deepEqual(writes, ["move", "restore"]);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  if (prefix)
    await writeFile(
      prefix + ".json",
      JSON.stringify({ metrics, writes, blocked, errors }, null, 2) + "\n",
    );
  console.log(
    "REQUEST_TRASH_CONFIRMATION_UI_PASS read-only-cancel/keyboard/430/owned-draft/explicit-soft-delete-save-and-restore/no-dispatch",
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
