import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const evidence = process.env.RECENT_SAVED_TRASH_EVIDENCE;
const root = await mkdtemp(join(tmpdir(), "workbench-recent-saved-trash-"));
const app = await createApp({ root, port: 0 });
let browser;
try {
  let owner = await app.store.create("默认项目");
  owner.requests = [
    ["fixture", "Trash Visual Fixture"],
    ["verification", "Verification"],
    ["untouched", "Untouched fixture"],
  ].map(([id, name]) =>
    normalizeRequest({
      id,
      name,
      method: "GET",
      url: "http://127.0.0.1:38982/no-send",
    }),
  );
  owner = await app.store.save(owner);
  const uri = "/api/projects/" + owner.id;
  const versionsUri = uri + "/recent-saved-definitions";
  const origin = new URL(app.launchUrl).origin;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
  });
  const blocked = [],
    errors = [],
    writes = [];
  let explicit = "",
    freshReads = 0,
    staleOnce = false;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin === origin && request.method() === "GET") {
      if (url.pathname === versionsUri) {
        freshReads++;
        if (staleOnce) {
          staleOnce = false;
          const response = await route.fetch();
          const json = await response.json();
          json.configRevision++;
          return route.fulfill({ response, json });
        }
      }
      return route.continue();
    }
    if (
      url.origin === origin &&
      request.method() === "PUT" &&
      url.pathname === uri &&
      explicit
    ) {
      writes.push(explicit);
      explicit = "";
      return route.continue();
    }
    blocked.push(request.method());
    return route.abort();
  });
  await page.goto(app.launchUrl);
  await page.waitForFunction(
    (id) =>
      document.querySelector("#project-select option[selected]")?.value === id,
    owner.id,
  );
  const savedTab = page.getByRole("tab", { name: "已保存版本" });
  const panel = page.getByRole("tabpanel", { name: "已保存版本" });
  const search = page.getByRole("searchbox", { name: "按已保存接口名称筛选" });
  const select = (name) =>
    panel.getByRole("checkbox", { name: "选择 " + name, exact: true });
  const alpha = select("Trash Visual Fixture");
  const beta = select("Verification");
  const batch = panel.getByRole("button", { name: "批量删除" });
  const selectionCancel = panel.getByRole("button", {
    name: "取消",
    exact: true,
  });
  const status = page.locator("#saved-state");
  const dialog = page.getByRole("dialog", { name: /将所选/ });
  const open = async () => {
    await page.locator('.rail [data-page="history"]').press("Enter");
    await savedTab.press("Enter");
    await alpha.waitFor();
  };
  const capture = async (name) => {
    if (!evidence) return;
    await mkdir(evidence, { recursive: true });
    await page.screenshot({
      path: join(evidence, "recent-workbench-batch-" + name + ".png"),
      caret: "hide",
    });
  };
  await open();
  const initial = await panel.evaluate((root) => {
    const bounds = (element) => {
      const { x, y } = element.getBoundingClientRect();
      return [Math.round(x), Math.round(y)];
    };
    return {
      date: bounds(root.querySelector("summary")),
      check: bounds(root.querySelector("input[type=checkbox]")),
    };
  });
  console.log("RECENT_SAVED_BATCH_BOUNDS", JSON.stringify(initial));
  assert.deepEqual(initial.date, [66, 108]);
  assert.equal(initial.check[0], 82);
  await capture("ready");
  await alpha.press("Space");
  assert(await alpha.isChecked());
  assert(await panel.getByText("已选择 1 项", { exact: true }).isVisible());
  const bar = await page.locator("#recent-saved-selection").boundingBox();
  assert.equal(Math.round(bar.y), 108);
  assert(
    await alpha
      .locator("xpath=ancestor::li")
      .evaluate((row) => row.classList.contains("recent-saved-selected")),
  );
  await capture("selected");
  await selectionCancel.press("Enter");
  assert(!(await alpha.isChecked()));
  assert(await batch.isHidden());
  assert(await alpha.evaluate((input) => input === document.activeElement));
  assert.equal(freshReads, 1);
  assert.equal(
    (await app.store.get(owner.id)).configRevision,
    owner.configRevision,
  );

  await alpha.press("Space");
  await page.setViewportSize({ width: 430, height: 760 });
  await capture("narrow");
  assert.equal(
    await panel.evaluate((node) => node.scrollWidth - node.clientWidth),
    0,
  );
  await batch.press("Enter");
  await dialog.waitFor();
  assert(
    await dialog
      .getByRole("button", { name: "取消", exact: true })
      .evaluate((input) => input === document.activeElement),
  );
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert(await batch.evaluate((input) => input === document.activeElement));
  assert.equal(freshReads, 1);
  await search.fill("Verification");
  assert(await batch.isHidden());
  await search.clear();
  assert(!(await alpha.isChecked()));

  await alpha.press("Space");
  await beta.press("Space");
  await batch.press("Enter");
  await dialog
    .getByRole("button", { name: "移到回收站", exact: true })
    .waitFor();
  staleOnce = true;
  await dialog
    .getByRole("button", { name: "移到回收站", exact: true })
    .press("Enter");
  await page
    .getByText("已保存版本或项目已变化，未移到回收站；请重新进入或重新读取", {
      exact: true,
    })
    .waitFor();
  assert.equal(await status.textContent(), "✓ 已保存");
  assert.deepEqual(writes, []);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await batch.press("Enter");
  await dialog
    .getByRole("button", { name: "移到回收站", exact: true })
    .press("Enter");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await status.textContent(), "● 未保存");
  assert(
    await panel
      .getByText(
        "所选接口已在项目草稿中移到回收站；点击「保存项目」才会写入。",
        { exact: true },
      )
      .isVisible(),
  );
  assert(
    await page
      .locator("#save-project")
      .evaluate((input) => input === document.activeElement),
  );
  assert.equal(freshReads, 3);
  assert.deepEqual(writes, []);
  assert.equal(
    (await app.store.get(owner.id)).configRevision,
    owner.configRevision,
  );

  await page.setViewportSize({ width: 1363, height: 1023 });
  const save = async (label, button) => {
    const result = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === uri && res.request().method() === "PUT",
    );
    explicit = label;
    const [response] = await Promise.all([result, button.press("Enter")]);
    assert(response.ok());
    await status.getByText("✓ 已保存", { exact: true }).waitFor();
  };
  await save("explicit project save", page.locator("#save-project"));
  const committed = await app.store.get(owner.id);
  assert.deepEqual(
    committed.requests.filter((row) => row.deletedAt).map((row) => row.id),
    ["fixture", "verification"],
  );
  await page.locator('.rail [data-page="trash"]').press("Enter");
  const restore = page.locator('[data-restore="fixture"]');
  await save("explicit restore", restore);
  const restored = await app.store.get(owner.id);
  assert.deepEqual(
    restored.requests.filter((row) => row.deletedAt).map((row) => row.id),
    ["verification"],
  );
  assert.deepEqual(writes, ["explicit project save", "explicit restore"]);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  console.log(
    "RECENT_SAVED_TRASH_UI_PASS 1363/430/cancel/filter/stale/focused/draft/explicit-save-and-restore/no-dispatch",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
