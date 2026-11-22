import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRequest } from "../src/core.mjs";
import { createApp } from "../src/server.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const storage = await mkdtemp(join(tmpdir(), "workbench-named-query-"));
const app = await createApp({ root: storage, port: 0 });
const origin = new URL(app.launchUrl).origin;
const first =
  '{"query":"query First { login }","variables": { "n":9007199254740993, "m":1e-2 },"operationName":"First"}';
const second = "query Second { role }";
const forbidden = [],
  errors = [],
  writes = [];
let browser;
try {
  let owner = await app.store.create("Named GraphQL synthetic");
  owner.requests = [
    normalizeRequest({
      id: "g",
      name: "Saved GraphQL fixture",
      method: "POST",
      url: "",
      bodyType: "json",
      body: first,
      graphqlEditorVersion: 1,
    }),
    normalizeRequest({
      id: "plain",
      name: "Ordinary HTTP",
      method: "POST",
      url: "",
      bodyType: "json",
      body: '{"ordinary":true}',
    }),
  ];
  owner = await app.store.save(owner);
  const before = structuredClone(await app.store.get(owner.id));
  const savePath = "/api/projects/" + owner.id;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
  });
  page.on("pageerror", () => errors.push("unexpected page error"));
  await page.addInitScript((id) => {
    sessionStorage.setItem("project", id);
    localStorage.setItem("response-layout", "stacked");
  }, owner.id);
  let maySave = false;
  await page.route("**/*", (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin === origin && request.method() === "GET")
      return route.continue();
    if (
      maySave &&
      writes.length === 0 &&
      url.origin === origin &&
      url.pathname === savePath &&
      request.method() === "PUT"
    ) {
      writes.push(request.postDataJSON());
      return route.continue();
    }
    forbidden.push(request.method());
    return route.abort();
  });
  await page.goto(app.launchUrl);
  const pane = page.getByRole("region", {
    name: "GraphQL 请求编辑",
    exact: true,
  });
  const rail = pane.getByRole("navigation", {
    name: "GraphQL 查询列表",
    exact: true,
  });
  const row = (name) => rail.getByRole("button", { name, exact: true });
  const more = (name) =>
    rail.getByRole("button", { name: "查询操作：" + name, exact: true });
  const plus = rail.locator("#graphql-named-add");
  const query = pane.getByRole("textbox", { name: "Query", exact: true });
  const vars = pane.getByRole("textbox", { name: "Variables", exact: true });
  const toggle = pane.getByRole("button", { name: "Variables", exact: true });
  const apply = pane.getByRole("button", { name: "应用到正文", exact: true });
  const discard = pane.getByRole("button", { name: "放弃", exact: true });
  const save = page.locator("#save-project");
  const modal = page.locator("#dialog");
  const names = () =>
    rail.locator("[data-graphql-query-row]").allTextContents();
  const activeName = () => rail.locator('[aria-current="true"]').textContent();
  const focus = (locator) =>
    locator.evaluate((node) => node === document.activeElement);
  const menu = rail.getByRole("menu", { name: "查询操作", exact: true });
  const rename = menu.getByRole("menuitem", { name: "重命名", exact: true });
  const remove = menu.getByRole("menuitem", { name: "删除", exact: true });
  const deletion = pane.getByRole("alertdialog", { name: "删除", exact: true });
  const cancelDelete = deletion.getByRole("button", {
    name: "取消",
    exact: true,
  });
  const applyDelete = deletion.getByRole("button", {
    name: "确定",
    exact: true,
  });
  const openDelete = async (name) => {
    await more(name).press("ArrowUp");
    assert.equal(await focus(remove), true);
    await remove.press("Enter");
    await deletion.waitFor();
    assert.equal(await focus(cancelDelete), true);
    const description = await deletion.evaluate(
      (node) =>
        node.ownerDocument.getElementById(node.getAttribute("aria-describedby"))
          .textContent,
    );
    assert(description.includes(name));
  };
  const escape = () => page.keyboard.press("Escape");
  const capture = async (label, narrow = false) => {
    const dir = process.env.GRAPHQL_NAMED_WORKSPACE_EVIDENCE;
    if (!dir) return;
    await mkdir(dir, { recursive: true });
    await page.screenshot({
      path: join(dir, "named-workbench-" + label + ".png"),
      caret: "hide",
      animations: "disabled",
      ...(narrow ? {} : { clip: { x: 355, y: 178, width: 1008, height: 401 } }),
    });
    if (!narrow)
      await page.screenshot({
        path: join(dir, "named-workbench-" + label + "-1363.png"),
        caret: "hide",
        animations: "disabled",
      });
  };

  await query.waitFor();
  assert.deepEqual(await names(), ["自定义查询"]);
  assert.equal(await activeName(), "自定义查询");
  await more("自定义查询").press("ArrowDown");
  await menu.waitFor();
  assert.equal(await focus(rename), true);
  assert.equal(await remove.count(), 0, "the only query cannot be deleted");
  await escape();
  await menu.waitFor({ state: "hidden" });
  assert.equal(await focus(more("自定义查询")), true);

  await query.fill("unapplied text remains here");
  await plus.press("Enter");
  assert.match(await pane.getByRole("alert").textContent(), /未应用/);
  assert.equal(await query.inputValue(), "unapplied text remains here");
  assert.deepEqual(await names(), ["自定义查询"]);
  await discard.press("Enter");
  assert.equal(await query.inputValue(), "query First { login }");

  await plus.press("Enter");
  assert.equal(await focus(query), true);
  assert.equal(await query.inputValue(), "");
  assert.deepEqual(await names(), ["自定义查询", "自定义查询 2"]);
  assert.equal(await activeName(), "自定义查询 2");
  await query.fill(second);
  await toggle.press("Enter");
  await vars.fill("null");
  await row("自定义查询").press("Enter");
  assert.match(await pane.getByRole("alert").textContent(), /未应用/);
  assert.equal(await query.inputValue(), second);
  await apply.press("Enter");

  await more("自定义查询 2").press("ArrowDown");
  await rename.press("Enter");
  const renameField = modal.getByRole("textbox", {
    name: "查询名称",
    exact: true,
  });
  assert.equal(await focus(renameField), true);
  await renameField.fill("stale rename");
  // Simulate a stale queued control callback while the shared dialog is open.
  await page
    .locator('[data-request="plain"]')
    .evaluate((element) => element.click());
  await modal.getByRole("button", { name: "确定", exact: true }).press("Enter");
  assert.match(await page.locator("#toast").textContent(), /查询或窗口已变化/);
  await escape();
  await modal.waitFor({ state: "hidden" });
  await page.locator('[data-request="g"]').click();
  assert.deepEqual(await names(), ["自定义查询", "自定义查询 2"]);
  await row("自定义查询").press("Enter");
  await row("自定义查询 2").press("Enter");
  assert.equal(await focus(row("自定义查询 2")), true);
  assert.equal(await query.inputValue(), second);
  assert.equal(await vars.inputValue(), "null");

  await more("自定义查询 2").press("ArrowDown");
  await rename.press("Enter");
  await renameField.fill("Second Fixture");
  await modal.getByRole("button", { name: "确定", exact: true }).press("Enter");
  await modal.waitFor({ state: "hidden" });
  assert.equal(await focus(more("Second Fixture")), true);
  assert.equal(await query.inputValue(), second);
  assert.equal(await activeName(), "Second Fixture");
  assert.equal(await pane.locator("#graphql-detach").count(), 0);
  assert.match(await pane.textContent(), /此接口包含命名查询/);
  const bounds = await rail.boundingBox();
  console.log("GRAPHQL_NAMED_GEOMETRY", JSON.stringify(bounds));
  await capture("second");
  assert.equal(Math.round(bounds.x), 371);
  assert.equal(Math.round(bounds.width), 188);

  await openDelete("Second Fixture");
  const desktopDelete = await deletion.boundingBox();
  console.log("GRAPHQL_NAMED_DELETE_GEOMETRY", JSON.stringify(desktopDelete));
  await capture("delete");
  assert(Math.abs(desktopDelete.x - 496) <= 3);
  assert(Math.abs(desktopDelete.y - 243) <= 6);
  assert.deepEqual(
    [desktopDelete.width, desktopDelete.height].map(Math.round),
    [128, 96],
  );
  await cancelDelete.press("Tab");
  assert.equal(await focus(applyDelete), true);
  await applyDelete.press("Shift+Tab");
  assert.equal(await focus(cancelDelete), true);
  await cancelDelete.press("Control+s");
  await cancelDelete.press("Control+Enter");
  assert.equal(await deletion.isVisible(), true);
  await escape();
  await deletion.waitFor({ state: "hidden" });
  assert.equal(await focus(more("Second Fixture")), true);
  assert.equal(await activeName(), "Second Fixture");

  await openDelete("Second Fixture");
  await query.click({ position: { x: 260, y: 20 } });
  await deletion.waitFor({ state: "hidden" });
  assert.equal(await focus(query), true);
  assert.equal(await activeName(), "Second Fixture");

  await openDelete("Second Fixture");
  const staleButton = await applyDelete.elementHandle();
  await page.locator('[data-request="plain"]').evaluate((node) => node.click());
  await staleButton.evaluate((node) => node.click());
  await page.locator('[data-request="g"]').click();
  assert.deepEqual(await names(), ["自定义查询", "Second Fixture"]);
  assert.equal(await activeName(), "Second Fixture");

  await plus.press("Enter");
  assert.equal(await activeName(), "自定义查询 3");
  await openDelete("自定义查询 3");
  await cancelDelete.press("Enter");
  await deletion.waitFor({ state: "hidden" });
  assert.equal(await activeName(), "自定义查询 3");
  assert.equal(await focus(more("自定义查询 3")), true);
  await openDelete("自定义查询 3");
  await applyDelete.press("Enter");
  await deletion.waitFor({ state: "hidden" });
  assert.deepEqual(await names(), ["自定义查询", "Second Fixture"]);
  assert.equal(await activeName(), "Second Fixture");
  assert.equal(await focus(row("Second Fixture")), true);
  assert.equal(await query.inputValue(), second);

  await row("自定义查询").press("Enter");
  assert.equal(await query.inputValue(), "query First { login }");
  assert.match(await vars.inputValue(), /9007199254740993/);
  await row("Second Fixture").press("Enter");
  assert.equal(await vars.inputValue(), "null");
  assert.deepEqual(await app.store.get(owner.id), before);

  maySave = true;
  const [saved] = await Promise.all([
    page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === savePath &&
        r.request().method() === "PUT",
    ),
    save.press("Enter"),
  ]);
  assert.equal(saved.status(), 200);
  await page.getByText("✓ 已保存", { exact: true }).waitFor();
  maySave = false;
  assert.equal(writes.length, 1);
  const request = (await app.store.get(owner.id)).requests.find(
    (r) => r.id === "g",
  );
  assert.deepEqual(JSON.parse(request.body), {
    query: second,
    variables: null,
  });
  const set = request.graphqlNamedQueries;
  assert.deepEqual(
    set.items.map(({ name }) => name),
    ["自定义查询", "Second Fixture"],
  );
  assert.equal(set.items[0].body, first);
  assert.equal(set.items[1].id, set.activeId);
  assert.equal(Object.hasOwn(set.items[1], "body"), false);

  await page.reload();
  assert.equal(await activeName(), "Second Fixture");
  assert.equal(await query.inputValue(), second);
  await page.setViewportSize({ width: 430, height: 830 });
  await openDelete("Second Fixture");
  const narrowDelete = await deletion.boundingBox();
  assert(narrowDelete.x >= 8 && narrowDelete.x + narrowDelete.width <= 422);
  assert(narrowDelete.y >= 8 && narrowDelete.y + narrowDelete.height <= 822);
  await capture("delete-narrow", true);
  await escape();
  assert.equal(await focus(more("Second Fixture")), true);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  await row("自定义查询").press("Enter");
  assert.equal(await focus(row("自定义查询")), true);
  assert.equal(await query.inputValue(), "query First { login }");
  await capture("narrow", true);
  assert.deepEqual(
    forbidden,
    [],
    "no GraphQL or other send; one explicit synthetic project save only",
  );
  assert.deepEqual(errors, []);
  console.log(
    "GRAPHQL_NAMED_WORKSPACE_UI_PASS order, real selection and bodies, stale modal, cancel/confirm, explicit save only, no dispatch",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(storage, { recursive: true, force: true });
}
