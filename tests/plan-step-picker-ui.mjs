import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest, snapshotPlan } from "../src/core.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const root = await mkdtemp(join(tmpdir(), "workbench-plan-picker-tree-"));
let app, browser;
try {
  app = await createApp({ root, port: 0 });
  let project = await app.store.create("默认项目");
  const endpoint = "http://127.0.0.1:38982";
  const makeRequest = (id, name, method = "GET", folder = "") =>
    normalizeRequest({ id, name, method, folder, url: endpoint + "/" + id });
  const original = makeRequest("verification", "Verification");
  project.requests.push(
    original,
    makeRequest("create", "创建用户", "POST", "示例接口"),
    makeRequest("read", "获取用户信息", "GET", "示例接口"),
    makeRequest("update", "修改用户信息", "PUT", "示例接口"),
    makeRequest("remove", "删除用户", "DELETE", "示例接口"),
  );
  project.plans.push(
    snapshotPlan({
      id: "verification-plan",
      name: "Verification Plan",
      environmentId: project.environments[0].id,
      steps: [{ id: "initial", name: original.name, request: original }],
    }),
  );
  await app.store.save(project);
  project = await app.store.get(project.id);
  const fixture = structuredClone(project);
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
  page.setDefaultTimeout(7000);
  const origin = new URL(app.launchUrl).origin;
  const savePath = "/api/projects/" + project.id + "/plans";
  const blocked = [],
    writes = [],
    errors = [],
    measurements = {};
  let allowSave = false;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("theme", "light"));
  await page.route("**/*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin && request.method() === "GET")
      return route.continue();
    if (
      allowSave &&
      url.origin === origin &&
      url.pathname === savePath &&
      request.method() === "POST"
    ) {
      writes.push(request.postDataJSON());
      return route.continue();
    }
    blocked.push([request.method(), url.pathname]);
    return route.abort();
  });
  const selectPlan = async (name) =>
    page
      .locator(".plan-list")
      .getByRole("button", { name, exact: true })
      .click();
  const openPage = async () => {
    await page.locator('header button[data-page="plans"]').click();
    await selectPlan("Verification Plan");
  };
  await page.goto(app.launchUrl);
  await openPage();
  const picker = page.locator("#plan-step-picker");
  const opener = picker.locator(":scope > summary");
  const search = picker.getByRole("searchbox", { name: "搜索接口" });
  const branch = picker.getByRole("button", { name: "示例接口", exact: true });
  const options = picker.locator(".plan-picker-option:visible");
  const add = page.locator("#add-step");
  const openPicker = async () => {
    await opener.focus();
    await opener.press("Enter");
    await search.waitFor();
    await page.waitForFunction(
      () => document.activeElement?.id === "plan-step-search",
    );
  };
  const prefix = process.env.PLAN_PICKER_CAPTURE_PREFIX;
  const capture = async (state) => {
    if (!prefix) return;
    await page.mouse.move(800, 88);
    await page.screenshot({
      path: `${prefix}-${state}.png`,
      clip: { x: 0, y: 0, width: 1363, height: 980 },
      caret: "hide",
      animations: "disabled",
    });
  };
  await page.evaluate(() => document.activeElement?.blur());
  await capture("one-step");
  await openPicker();
  assert.equal(await branch.getAttribute("aria-expanded"), "true");
  const nativeLabels = [
    "POST 创建用户",
    "GET 获取用户信息",
    "PUT 修改用户信息",
    "DELETE 删除用户",
    "GET Verification",
  ];
  assert.deepEqual(await options.allTextContents(), nativeLabels);
  const popup = picker.locator(".plan-picker-popover");
  measurements.expanded = await popup.boundingBox();
  measurements.input = await search.boundingBox();
  assert.deepEqual(
    [
      measurements.input.x,
      measurements.input.y,
      measurements.expanded.x,
      measurements.expanded.y,
      measurements.expanded.width,
    ],
    [370, 523, 370, 559, 662],
  );
  const checkboxes = options.locator("input");
  const childBox = await checkboxes.first().boundingBox();
  const rootBox = await checkboxes.last().boundingBox();
  measurements.requestIndent = {
    child: childBox,
    root: rootBox,
    padding: await options.evaluateAll((rows) =>
      rows.map((row) => getComputedStyle(row).paddingInlineStart),
    ),
  };
  assert.equal(
    childBox.x - rootBox.x,
    24,
    JSON.stringify(measurements.requestIndent),
  );
  await capture("expanded");
  await branch.press("Space");
  assert.equal(await branch.getAttribute("aria-expanded"), "false");
  assert.deepEqual(await options.allTextContents(), ["GET Verification"]);
  measurements.collapsed = await popup.boundingBox();
  await search.focus();
  await capture("collapsed");
  await branch.press("Enter");
  assert.deepEqual(await options.allTextContents(), nativeLabels);
  await picker
    .getByRole("checkbox", { name: "POST 创建用户", exact: true })
    .press("Space");
  await branch.click();
  assert.equal(await add.isEnabled(), true);
  assert.equal(await picker.locator('input[value="create"]').isChecked(), true);
  await search.fill("获取用户");
  assert.equal(await branch.getAttribute("aria-expanded"), "true");
  assert.deepEqual(await options.allTextContents(), ["GET 获取用户信息"]);
  await picker
    .getByRole("checkbox", { name: "GET 获取用户信息", exact: true })
    .check();
  await search.fill("无匹配");
  assert.equal(await picker.getByRole("status").isVisible(), true);
  assert.equal(await picker.locator("input:checked").count(), 2);
  await search.fill("");
  assert.equal(await branch.getAttribute("aria-expanded"), "false");
  assert.deepEqual(await options.allTextContents(), ["GET Verification"]);
  await search.press("Escape");
  assert.equal(await picker.getAttribute("open"), null);
  assert.equal(
    await opener.evaluate((el) => el === document.activeElement),
    true,
  );
  await openPicker();
  assert.equal(await picker.locator("input:checked").count(), 2);
  assert.equal(await page.locator(".plan-step").count(), 1);
  assert.deepEqual(await app.store.get(project.id), fixture);
  assert.deepEqual(writes, []);
  allowSave = true;
  const [saved] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === savePath &&
        response.request().method() === "POST",
    ),
    add.click(),
  ]);
  allowSave = false;
  assert.equal(saved.status(), 200);
  await page.locator(".plan-step").nth(2).waitFor();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].id, "verification-plan");
  project = await app.store.get(project.id);
  assert.deepEqual(
    project.plans[0].steps.map((step) => step.name),
    ["Verification", "创建用户", "获取用户信息"],
  );

  // Extend the ephemeral fixture only after the same-state captures.
  project.requests.push(
    makeRequest("nested", "深层验证", "PATCH", "示例接口/账户"),
    {
      ...makeRequest("removed", "已删除"),
      deletedAt: new Date().toISOString(),
    },
  );
  project.plans.push(
    snapshotPlan({ id: "other-plan", name: "Other Plan", steps: [] }),
  );
  await app.store.save(project);
  const extended = await app.store.get(project.id);
  await page.reload();
  await openPage();
  await page.setViewportSize({ width: 430, height: 780 });
  await openPicker();
  const nested = picker.getByRole("button", { name: "账户", exact: true });
  const nestedRequest = picker.getByRole("checkbox", {
    name: "PATCH 深层验证",
    exact: true,
  });
  assert.equal(await nested.isVisible(), true);
  for (const control of [search, popup, add]) {
    const box = await control.boundingBox();
    assert.ok(
      box && box.x >= 0 && box.x + box.width <= 430,
      JSON.stringify(box),
    );
  }
  await nested.press("Space");
  assert.equal(await nestedRequest.isVisible(), false);
  await search.fill("示例接口/账户");
  assert.equal(await nestedRequest.isVisible(), true);
  await nestedRequest.check();
  assert.equal(await picker.locator('input[value="removed"]').count(), 0);
  await selectPlan("Other Plan");
  await openPicker();
  assert.equal(await picker.locator("input:checked").count(), 0);
  assert.equal(await add.isEnabled(), false);
  await selectPlan("Verification Plan");
  await openPicker();
  assert.equal(await picker.locator("input:checked").count(), 0);
  assert.deepEqual(await app.store.get(project.id), extended);
  assert.equal(writes.length, 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  if (prefix)
    await writeFile(
      `${prefix}.json`,
      JSON.stringify(
        {
          measurements,
          errors,
          blocked,
          explicitPlanWrites: writes.length,
          nativeLabels,
        },
        null,
        2,
      ) + "\n",
    );
  console.log(
    "PLAN_STEP_PICKER_UI_PASS expanded/collapsed/filter/keyboard/owner/narrow/one-explicit-plan-save/no-dispatch",
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
