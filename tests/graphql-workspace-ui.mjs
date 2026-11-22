import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRequest } from "../src/core.mjs";
import { createApp } from "../src/server.mjs";
import { assertGraphQLBadge } from "./helpers/graphql-badge-ui.mjs";

const playwright = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const engine = process.env.GRAPHQL_BROWSER || "chromium";
assert(["chromium", "firefox"].includes(engine));
const root = await mkdtemp(join(tmpdir(), "workbench-graphql-workspace-"));
const app = await createApp({ root, port: 0 });
const origin = new URL(app.launchUrl).origin;
const forbidden = [],
  errors = [],
  writes = [];
let browser;
try {
  let owner = await app.store.create("GraphQL local editor");
  const unsupported = '{"query":"old", "extensions":{"localOnly":true}}';
  owner.requests = [
    normalizeRequest({
      id: "plain",
      name: "Ordinary HTTP",
      method: "POST",
      bodyType: "json",
      body: '{"name":"ordinary"}',
    }),
    normalizeRequest({
      id: "legacy",
      name: "Unsupported envelope",
      method: "POST",
      bodyType: "json",
      body: unsupported,
      graphqlEditorVersion: 1,
    }),
  ];
  owner = await app.store.save(owner);
  const savedBefore = structuredClone(await app.store.get(owner.id));
  browser = await playwright[engine].launch({
    executablePath:
      engine === "chromium"
        ? process.env.CHROMIUM_PATH || undefined
        : undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
  });
  page.on("pageerror", () => errors.push("unexpected browser error"));
  await page.addInitScript((id) => {
    sessionStorage.setItem("project", id);
    localStorage.setItem("response-layout", "stacked");
  }, owner.id);
  let allowSave = false;
  const savePath = "/api/projects/" + owner.id;
  await page.route("**/*", (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin === origin && request.method() === "GET")
      return route.continue();
    if (
      allowSave &&
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
  const ordinary = page.locator('[data-request="plain"]');
  const create = page.locator(".tree-create summary");
  const tile = page.getByRole("button", { name: "GraphQL 请求", exact: true });
  const pane = page.getByRole("region", {
    name: "GraphQL 请求编辑",
    exact: true,
  });
  const query = pane.getByRole("textbox", { name: "Query", exact: true });
  const vars = pane.getByRole("textbox", { name: "Variables", exact: true });
  const toggle = pane.getByRole("button", { name: "Variables", exact: true });
  const apply = pane.getByRole("button", { name: "应用到正文", exact: true });
  const discard = pane.getByRole("button", { name: "放弃", exact: true });
  const raw = page.locator("#body-code");
  const toast = page.locator("#toast");
  const projectSave = page.locator("#save-project");
  const selectedTab = page.locator(".tab.selected");
  const focus = (locator) =>
    locator.evaluate((node) => node === document.activeElement);
  const screenshot = async (name, narrow = false) => {
    const dir = process.env.GRAPHQL_WORKSPACE_EVIDENCE;
    if (!dir) return;
    await mkdir(dir, { recursive: true });
    await page.mouse.move(narrow ? 426 : 1360, 85);
    await page.screenshot({
      path: join(dir, "graphql-workbench-" + name + ".png"),
      caret: "hide",
      animations: "disabled",
      ...(narrow ? {} : { clip: { x: 355, y: 85, width: 1008, height: 550 } }),
    });
  };
  await page.locator('[data-param="body"]').press("Enter");
  assert.equal(await raw.inputValue(), '{"name":"ordinary"}');
  assert.equal(await pane.count(), 0);
  assert.equal(await ordinary.locator(".method").innerText(), "POST");
  assert.equal(await ordinary.locator(".graphql-badge").count(), 0);
  await create.press("Space");
  await tile.press("Enter");
  await query.waitFor();
  assert.equal(await focus(query), true);
  assert.equal(await query.inputValue(), "");
  assert.equal(await vars.isVisible(), false);
  assert.equal(await page.locator("#method").inputValue(), "POST");
  const id = await selectedTab
    .locator("[data-open-tab]")
    .getAttribute("data-open-tab");
  const treeItem = page.locator(`[data-request="${id}"]`);
  const activeTab = selectedTab.locator("[data-open-tab]");
  await assertGraphQLBadge(treeItem);
  await assertGraphQLBadge(activeTab);
  const tabs = await page
    .locator(".param-tabs [data-param]")
    .evaluateAll((nodes) => nodes.map((node) => node.dataset.param));
  assert.deepEqual(tabs.slice(0, 6), [
    "graphql",
    "headers",
    "auth",
    "cookies",
    "before",
    "after",
  ]);
  assert.equal(
    await pane.getByRole("button", { name: /获取\s*schema|刷新/i }).count(),
    0,
  );
  const namedQueries = pane.getByRole("navigation", {
    name: "GraphQL 查询列表",
    exact: true,
  });
  const addQuery = namedQueries.getByRole("button", {
    name: "＋ 新建查询",
    exact: true,
  });
  assert.equal(await addQuery.count(), 1);
  assert.equal(await addQuery.isVisible(), true);
  assert.equal(await addQuery.isEnabled(), true);
  await page.locator('[data-param="graphql"]').focus();
  await screenshot("query");
  await toggle.press("Space");
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  assert.equal(await focus(toggle), true);
  assert.equal(await vars.inputValue(), "");
  await screenshot("variables-open");

  const queryText = "\nquery Verify($count: Int) { fixture(count: $count) }";
  const variables = '{"count":1e2,"literal":"safe"}';
  await query.fill(queryText);
  await vars.fill("{broken");
  await apply.press("Enter");
  assert.equal(await pane.getByRole("alert").isVisible(), true);
  assert.equal(await apply.isVisible(), true);
  await query.press("Control+Enter");
  assert.match(await toast.textContent(), /未应用/);
  await projectSave.press("Enter");
  assert.match(await toast.textContent(), /未应用/);
  await selectedTab.locator(".tab-close").press("Enter");
  assert.equal(await query.isVisible(), true);
  assert.match(await toast.textContent(), /未应用/);
  await ordinary.click();
  assert.equal(await raw.inputValue(), '{"name":"ordinary"}');
  await projectSave.press("Enter");
  assert.match(await toast.textContent(), /未应用/);
  await treeItem.click();
  assert.equal(await query.inputValue(), queryText);
  assert.equal(await vars.inputValue(), "{broken");
  await toggle.press("Enter");
  assert.equal(await vars.isVisible(), false);
  await toggle.press("Enter");
  assert.equal(await vars.inputValue(), "{broken");
  await discard.press("Enter");
  assert.equal(await query.inputValue(), "");
  assert.equal(await vars.inputValue(), "");
  assert.equal(await apply.isVisible(), false);
  assert.deepEqual(await app.store.get(owner.id), savedBefore);

  await query.fill(queryText);
  await vars.fill(variables);
  await apply.press("Enter");
  assert.equal(await pane.getByRole("alert").isVisible(), false);
  assert.equal(await focus(query), true);
  assert.equal(await query.inputValue(), queryText);
  assert.equal(await vars.inputValue(), variables);
  await page.locator('[data-response="headers"]').press("Enter");
  assert.equal(
    await page
      .locator('[data-response="headers"]')
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(await query.inputValue(), queryText);
  assert.deepEqual(await app.store.get(owner.id), savedBefore);
  allowSave = true;
  const [settled] = await Promise.all([
    page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === savePath &&
        res.request().method() === "PUT",
    ),
    projectSave.press("Enter"),
  ]);
  assert.equal(settled.status(), 200);
  await page.getByText("✓ 已保存", { exact: true }).waitFor();
  allowSave = false;
  assert.equal(writes.length, 1);
  const request = (await app.store.get(owner.id)).requests.find(
    (r) => r.id === id,
  );
  assert.equal(request.graphqlEditorVersion, 1);
  assert.equal(request.method, "POST");
  assert.equal(request.bodyType, "json");
  assert.equal(JSON.parse(request.body).query, queryText);
  assert.match(request.body, /"count":1e2/);

  await page.reload();
  await treeItem.click();
  assert.equal(await query.inputValue(), queryText);
  assert.equal(await vars.isVisible(), false);
  await toggle.press("Enter");
  assert.equal(await vars.inputValue(), variables);
  await page.locator('[data-request="legacy"]').click();
  assert.equal(await query.count(), 0);
  assert.match(await pane.textContent(), /无法用 Query/);
  await pane
    .getByRole("button", { name: "使用原始 HTTP 正文", exact: true })
    .press("Enter");
  assert.equal(await raw.inputValue(), unsupported);
  assert.equal(await focus(raw), true);
  await treeItem.click();
  await page.setViewportSize({ width: 430, height: 830 });
  await assertGraphQLBadge(treeItem);
  await assertGraphQLBadge(activeTab);
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.press("Enter");
  assert.equal(await vars.isVisible(), true);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  const bounds = await pane.boundingBox();
  assert(bounds.x >= 0 && bounds.x + bounds.width <= 430);
  await screenshot("narrow", true);
  assert.equal(
    (await app.store.get(owner.id)).requests.find((r) => r.id === "legacy")
      .body,
    unsupported,
  );
  assert.deepEqual(
    forbidden,
    [],
    "visual interaction and blocked shortcuts never dispatch",
  );
  assert.deepEqual(errors, []);
  console.log(
    "GRAPHQL_WORKSPACE_UI_PASS draft ownership, lexical JSON, only explicit save, no dispatch, narrow keyboard",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
