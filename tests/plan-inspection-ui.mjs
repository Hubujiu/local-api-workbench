import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest, snapshotPlan } from "../src/core.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const root = await mkdtemp(join(tmpdir(), "workbench-plan-inspect-"));
const privateFixture = "synthetic-not-for-inspection";
const endpoint = "http://127.0.0.1:38982/verification";
const evidence = process.env.PLAN_INSPECTION_EVIDENCE;
let app, browser;
try {
  app = await createApp({ root, port: 0 });
  let project = await app.store.create("Inspection fixture");
  const plain = project.environments[0];
  const lab = {
    id: "lab",
    name: "本地检查环境",
    variables: { count: 0, extra: privateFixture },
  };
  project.environments.push(lab);
  project.servers = [{ id: "default-service", name: "默认服务" }];
  lab.serverUrls = { "default-service": endpoint + "/" + privateFixture };
  const source = normalizeRequest({
    id: "source",
    name: "Verification source",
    url: endpoint,
    headers: [{ key: "X-Source-Only", value: "source value" }],
  });
  const snapshot = normalizeRequest({
    ...source,
    headers: [{ key: "X-Snapshot-Only", value: privateFixture }],
    cookies: [{ key: "session", value: privateFixture }],
    bodyType: "json",
    body: JSON.stringify({ body: privateFixture }),
    auth: { type: "bearer", token: privateFixture },
    beforeScript: `console.log("${privateFixture}")`,
  });
  const plan = snapshotPlan({
    id: "verification-plan",
    name: "Verification Plan",
    environmentId: lab.id,
    steps: [
      { id: "verification-step", name: "Verification", request: snapshot },
    ],
  });
  const empty = snapshotPlan({
    id: "empty-plan",
    name: "Empty Plan",
    environmentId: plain.id,
    steps: [],
  });
  project.requests.push(source);
  project.plans.push(plan, empty);
  project.runs.push({
    id: "retained-run",
    planId: plan.id,
    planName: plan.name,
    source: "manual",
    status: "failed",
    createdAt: "2026-11-21T07:29:50Z",
    planHash: "a".repeat(64),
    results: [
      {
        name: "Verification",
        status: "failed",
        response: {
          status: 403,
          duration: 5,
          request: { url: endpoint, method: "GET" },
        },
        assertions: [
          {
            passed: false,
            target: "status",
            op: "eq",
            actual: 403,
            value: 200,
          },
        ],
      },
    ],
  });
  await app.store.save(project);
  project = await app.store.get(project.id);
  const baseline = structuredClone(project);

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
  const blocked = [],
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("theme", "light"));
  await page.route("**/*", (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (
      url.origin === origin &&
      request.method() === "GET" &&
      !/\/(?:execute|run|run-plan|plan-runs)\b/.test(url.pathname)
    )
      return route.continue();
    blocked.push([
      request.method(),
      url.origin === origin ? url.pathname : "external",
    ]);
    return route.abort();
  });
  if (evidence) await mkdir(evidence, { recursive: true });
  const capture = async (state) => {
    if (evidence)
      await page.screenshot({
        path: join(evidence, `plan-inspection-${state}.png`),
        caret: "hide",
        animations: "disabled",
      });
  };
  const focused = (item) =>
    item.evaluate((node) => node === document.activeElement);
  const selectPlan = (name) =>
    page
      .locator(".plan-list")
      .getByRole("button", { name, exact: true })
      .click();
  const openEnvironment = page.getByRole("button", { name: "查看执行环境" });
  const drawer = page.locator("#plan-environment-inspection");
  const close = drawer.getByRole("button", { name: "关闭执行环境" });
  const currentPanel = (root) => root.locator('[role="tabpanel"]:visible');
  const fitsViewport = async (element, width) => {
    const frame = await element.boundingBox();
    assert.ok(
      frame?.width > 0 && frame.x >= 0 && frame.x + frame.width <= width + 1,
      JSON.stringify(frame),
    );
  };

  await page.goto(app.launchUrl);
  await page.locator('header button[data-page="plans"]').click();
  await selectPlan("Empty Plan");
  await openEnvironment.press("Enter");
  await close.waitFor();
  assert.equal(await focused(close), true);
  const frame = await drawer.boundingBox();
  assert.deepEqual(frame, { x: 723, y: 44, width: 640, height: 979 });
  await currentPanel(drawer).getByText("暂无变量", { exact: true }).waitFor();
  await capture("empty");
  const envTab = drawer.getByRole("tab", { name: "环境变量(0)" });
  const globalTab = drawer.getByRole("tab", { name: "全局变量(0)" });
  await envTab.press("ArrowRight");
  assert.equal(await globalTab.getAttribute("aria-selected"), "true");
  assert.equal(await focused(globalTab), true);
  assert.equal(
    await drawer.getByRole("region", { name: "环境服务" }).count(),
    0,
  );
  await page.keyboard.press("Escape");
  assert.equal(await drawer.isVisible(), false);
  assert.equal(await focused(openEnvironment), true);

  await selectPlan("Verification Plan");
  const description = page.locator("#plan-description");
  await description.fill("Unsaved inspection draft");
  assert.equal(await page.locator("#plan-env").inputValue(), lab.id);
  await openEnvironment.click();
  await drawer.getByRole("heading", { name: lab.name }).waitFor();
  await currentPanel(drawer).getByText("默认服务", { exact: true }).waitFor();
  await currentPanel(drawer).getByText("extra", { exact: true }).waitFor();
  assert.doesNotMatch(await drawer.innerHTML(), new RegExp(privateFixture));
  await capture("populated");
  await close.click();
  assert.equal(await focused(openEnvironment), true);
  assert.equal(await description.inputValue(), "Unsaved inspection draft");

  const step = page.getByRole("button", { name: "Verification", exact: true });
  await step.press("Space");
  assert.equal(await step.getAttribute("aria-expanded"), "true");
  const snapshotPanel = page.getByRole("region", { name: "请求快照" });
  await currentPanel(snapshotPanel)
    .getByText("X-Snapshot-Only", { exact: true })
    .waitFor();
  assert.doesNotMatch(
    await snapshotPanel.innerHTML(),
    new RegExp(privateFixture + "|X-Source-Only"),
  );
  await capture("snapshot");
  const path = snapshotPanel.getByRole("tab", { name: "路径参数" });
  await path.click();
  await currentPanel(snapshotPanel)
    .getByText("暂无路径参数", { exact: true })
    .waitFor();
  await capture("snapshot-path");
  await path.press("ArrowRight");
  await currentPanel(snapshotPanel)
    .getByText("内容已隐藏", { exact: false })
    .waitFor();
  await snapshotPanel.getByRole("tab", { name: "认证" }).click();
  await currentPanel(snapshotPanel)
    .getByText("bearer", { exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await step.getAttribute("aria-expanded"), "false");
  assert.equal(await focused(step), true);

  await page.getByRole("button", { name: "执行记录", exact: true }).click();
  const record = page.locator('[data-plan-run-id="retained-run"]');
  await record.locator(":scope > summary").press("Space");
  await record.getByText("接口返回状态码 403，期望 200").waitFor();
  await record.locator("[data-run-step] > summary").press("Enter");
  await record.getByText("断言结果", { exact: true }).waitFor();
  await record.getByRole("button", { name: "导出证据 JSON" }).waitFor();
  await capture("history");
  await page.locator('[data-plan-tab="plans"]').click();
  assert.equal(await description.inputValue(), "Unsaved inspection draft");

  await page.setViewportSize({ width: 430, height: 780 });
  await openEnvironment.press("Enter");
  assert.equal((await drawer.boundingBox())?.width, 430);
  await drawer.getByRole("tab", { name: "环境变量(2)" }).press("End");
  assert.equal(
    await drawer
      .getByRole("tab", { name: "全局变量(0)" })
      .getAttribute("aria-selected"),
    "true",
  );
  await fitsViewport(drawer, 430);
  await capture("narrow-drawer");
  await page.keyboard.press("Escape");
  await step.press("Space");
  await snapshotPanel.getByRole("tab", { name: "脚本" }).click();
  await currentPanel(snapshotPanel)
    .getByText("已记录（源码已隐藏）", { exact: true })
    .waitFor();
  await fitsViewport(snapshotPanel, 430);
  await capture("narrow-snapshot");
  await step.click();
  assert.equal(await step.getAttribute("aria-expanded"), "false");

  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(await app.store.get(project.id), baseline);
  console.log(
    "PLAN_INSPECTION_UI_PASS",
    "drawer/snapshot/retained history/draft/430/no dispatch or writes",
  );
} finally {
  try {
    await browser?.close();
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
}
