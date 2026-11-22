import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { snapshotCase } from "../src/cases.mjs";
import { normalizeRequest } from "../src/core.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const evidence = process.env.CASE_LIST_EVIDENCE;
const root = await mkdtemp("/tmp/workbench-case-list-");
const app = await createApp({ root, port: 0 });
let browser;
try {
  const nativeState = await app.store.create("默认项目");
  const batch = await app.store.create("Synthetic selection");
  const verification = normalizeRequest({
    id: "verification",
    name: "Verification",
    method: "GET",
    url: "http://127.0.0.1:32187/verification",
  });
  const secondary = normalizeRequest({
    ...verification,
    id: "alternate",
    name: "Alternate fixture",
  });
  const snapshot = (id, name, request, folderId) =>
    snapshotCase({ id, name, sourceRequestId: request.id, request, folderId });
  nativeState.requests = [verification];
  nativeState.cases = [snapshot("native-case", "新建用例", verification)];
  await app.store.save(nativeState);
  batch.requests = [verification, secondary];
  batch.caseFolders = [
    { id: "case-group", name: "合成分组", sourceRequestId: verification.id },
  ];
  batch.cases = [
    snapshot("batch-first", "Synthetic first", verification),
    snapshot("batch-grouped", "Synthetic grouped", verification, "case-group"),
    snapshot("batch-alternate", "Alternate case", secondary),
  ];
  await app.store.save(batch);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
  });
  const origin = new URL(app.launchUrl).origin;
  const blocked = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin === origin && request.method() === "GET")
      return route.continue();
    blocked.push(request.method() + " " + url.pathname);
    return route.abort();
  });
  if (evidence) await mkdir(evidence, { recursive: true });
  await page.goto(app.launchUrl);
  const projectSelect = page.locator("#project-select");
  const renderedOwner = projectSelect.locator("option[selected]");
  const tab = page.getByRole("button", { name: "接口用例", exact: true });
  const caseArea = page.getByRole("region", { name: "接口用例", exact: true });
  const selectAll = caseArea.getByRole("checkbox", { name: "全选" });
  const nativeRow = caseArea
    .locator(".interface-case-row")
    .filter({ hasText: "新建用例" });
  const selection = (id) => caseArea.locator(`[data-select-case="${id}"]`);
  const focusIs = (locator) =>
    locator.evaluate(
      (element) => element.ownerDocument.activeElement === element,
    );
  const adoptProject = async (id) => {
    // The DOM attribute is generated from the application owner on render.
    // selectOption changes the control value before the asynchronous load adopts it.
    if ((await renderedOwner.getAttribute("value")) === id) return;
    await projectSelect.selectOption(id);
    await page.waitForFunction(
      (expected) =>
        document
          .querySelector("#project-select option[selected]")
          ?.getAttribute("value") === expected,
      id,
    );
  };
  const confirmFixture = async (projectId, phase, verify) => {
    try {
      await adoptProject(projectId);
      await verify();
    } catch (error) {
      const state = await page
        .evaluate((expected) => {
          const select = document.querySelector("#project-select");
          return {
            renderedOwnerMatches:
              select
                ?.querySelector("option[selected]")
                ?.getAttribute("value") === expected,
            selectedValueMatches: select?.value === expected,
            caseModeActive:
              document
                .querySelector('[data-mode="cases"]')
                ?.getAttribute("aria-pressed") === "true",
            nativeCasePresent: Boolean(
              document.querySelector('[data-select-case="native-case"]'),
            ),
            batchCasePresent: Boolean(
              document.querySelector('[data-select-case="batch-first"]'),
            ),
          };
        }, projectId)
        .catch(() => null);
      console.error("INTERFACE_CASE_FIXTURE_STATE", phase, state);
      throw error;
    }
  };
  await confirmFixture(nativeState.id, "native-list", async () => {
    await tab.press("Enter");
    await nativeRow.getByText("新建用例", { exact: true }).waitFor();
  });
  const metrics = await caseArea.evaluate((panel) => {
    const bounds = (selector) => {
      const { x, y, width, height } = panel
        .querySelector(selector)
        .getBoundingClientRect();
      return [x, y, width, height].map(Math.round);
    };
    return {
      aside: bounds(".case-empty-menu"),
      toolbar: bounds(".case-selection"),
      row: bounds(".interface-case-row"),
      check: bounds("[data-select-case]"),
    };
  });
  if (evidence)
    await page.screenshot({
      path: join(evidence, "workbench-case-verification-populated.png"),
      clip: { x: 0, y: 0, width: 1363, height: 980 },
      caret: "hide",
      animations: "disabled",
    });
  console.log("CASE_LIST_BOUNDS", JSON.stringify(metrics));
  assert.deepEqual(metrics.aside.slice(0, 3), [371, 138, 195]);
  assert.deepEqual(metrics.toolbar.slice(0, 2), [578, 138]);
  assert.deepEqual(metrics.row, [578, 176, 769, 40]);
  assert.equal(metrics.check[0], 595);
  assert.deepEqual(await nativeRow.locator(".method").allTextContents(), [
    "GET",
  ]);
  assert.equal(await nativeRow.locator(".case-result").count(), 0);
  assert(await caseArea.getByRole("button", { name: "添加分组" }).isVisible());
  assert(await caseArea.getByRole("button", { name: "添加用例" }).isVisible());
  assert(await caseArea.getByRole("button", { name: "全部运行" }).isEnabled());
  assert(await nativeRow.getByRole("button", { name: "运行用例" }).isEnabled());
  assert(await nativeRow.getByRole("button", { name: "编辑快照" }).isEnabled());
  assert(await nativeRow.getByRole("button", { name: "删除" }).isEnabled());

  await nativeRow.locator(".case-row-address > summary").press("Enter");
  const address = nativeRow.locator(".case-row-address code");
  await address.waitFor();
  assert.equal(await address.textContent(), verification.url);
  await selection("native-case").press("Space");
  assert(await focusIs(selection("native-case")));
  assert(await selectAll.isChecked());
  assert(
    await nativeRow
      .locator(".case-row-address")
      .evaluate((detail) => detail.open),
  );
  await selectAll.press("Space");
  assert(await focusIs(selectAll));
  assert(!(await selection("native-case").isChecked()));

  await confirmFixture(batch.id, "batch-list", () =>
    selection("batch-first").waitFor(),
  );
  assert(!(await selectAll.isChecked()));
  assert(await selection("batch-alternate").isHidden());
  await selection("batch-first").press("Space");
  assert(await selectAll.evaluate((input) => input.indeterminate));
  assert(await caseArea.getByRole("button", { name: "运行所选" }).isEnabled());
  const group = caseArea.locator('[data-case-folder="case-group"]');
  await group.locator(":scope > summary").press("Enter");
  assert(await selection("batch-grouped").isHidden());
  await selectAll.press("Space");
  assert(await focusIs(selectAll));
  assert(await selectAll.isChecked());
  assert(!(await selectAll.evaluate((input) => input.indeterminate)));
  assert(await selection("batch-grouped").isChecked());
  assert(!(await group.evaluate((detail) => detail.open)));
  await selectAll.press("Space");
  assert(!(await selection("batch-first").isChecked()));

  await page.setViewportSize({ width: 430, height: 760 });
  await selectAll.press("Space");
  assert(await focusIs(selectAll));
  assert.deepEqual(
    await page.evaluate(() => [
      innerWidth,
      document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ]),
    [430, 0],
  );
  const stage = await caseArea.locator(".case-list-stage").boundingBox();
  assert(stage.width > 200 && stage.x + stage.width <= 430);
  assert(await caseArea.getByRole("button", { name: "移动所选" }).isEnabled());
  assert(await caseArea.getByRole("button", { name: "删除所选" }).isEnabled());
  await caseArea.getByRole("button", { name: "移动所选" }).press("Enter");
  const dialog = page.getByRole("dialog", { name: "批量移动用例" });
  await dialog.getByText("移动 2 个用例，不改变请求快照。").waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(
    (await app.store.get(nativeState.id)).cases,
    nativeState.cases,
  );
  assert.deepEqual((await app.store.get(batch.id)).cases, batch.cases);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  console.log(
    "INTERFACE_CASE_LIST_PASS stored/method/address/selection/indeterminate/focus/narrow/no-writes",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
