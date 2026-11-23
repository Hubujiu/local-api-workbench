import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRequest } from "../src/core.mjs";
import { createApp } from "../src/server.mjs";
import { bindExampleStartupTrace } from "./helpers/http-debug-examples-startup.mjs";
import { isMockTransportRoute } from "./helpers/mock-transport-route.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const home = await mkdtemp(join(tmpdir(), "workbench-debug-examples-"));
let app, browser;
try {
  app = await createApp({ root: home, port: 0 });
  const owner = await app.store.create("Response example fixture");
  const url = "http://127.0.0.1:38982/verification";
  const a = normalizeRequest({
    id: "example-a",
    name: "Verification",
    url,
  });
  const b = normalizeRequest({
    id: "example-b",
    name: "Independent",
    url,
    examples: [
      {
        name: "Existing JSON",
        status: 201,
        body: '{"id":7}',
        headers: { "Content-Type": "application/json", "X-Fixture": "keep" },
        delayMs: 23,
      },
      {
        name: "Opaque XML",
        status: 404,
        body: "<fixture>unchanged</fixture>",
        headers: { "content-type": "application/xml" },
      },
    ],
  });
  owner.requests.push(
    a,
    b,
    normalizeRequest({
      id: "folder-fixture",
      name: "Tree fixture",
      folder: "Fixture folder",
      url,
    }),
  );
  await app.store.save(owner);
  const baseline = await app.store.get(owner.id);
  assert.deepEqual(
    baseline.requests.map(({ id }) => id),
    [a.id, b.id, "folder-fixture"],
  );
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    locale: "zh-CN",
    deviceScaleFactor: 1,
  });
  await page.addInitScript((id) => {
    localStorage.setItem("theme", "light");
    sessionStorage.setItem("project", id);
  }, owner.id);
  const origin = new URL(app.launchUrl).origin;
  const ownerPath = "/api/projects/" + owner.id;
  const startup = bindExampleStartupTrace(page, origin, ownerPath);
  const writes = [],
    forbidden = [];
  let allowSave = false;
  await page.route("**/*", (route) => {
    const req = route.request(),
      dest = new URL(req.url());
    if (
      dest.origin === origin &&
      req.method() === "GET" &&
      !isMockTransportRoute(dest.pathname)
    )
      return route.continue();
    if (
      allowSave &&
      !writes.length &&
      dest.origin === origin &&
      dest.pathname === ownerPath &&
      req.method() === "PUT"
    ) {
      writes.push(req.method());
      return route.continue();
    }
    forbidden.push([req.method(), dest.pathname]);
    return route.abort();
  });
  const evidence = process.env.HTTP_DEBUG_EXAMPLE_EVIDENCE;
  if (evidence) await mkdir(evidence, { recursive: true });
  const capture = async (state) => {
    if (evidence)
      await page.screenshot({
        path: join(evidence, "http-debug-example-" + state + ".png"),
        caret: "hide",
        animations: "disabled",
      });
  };
  const pane = page.getByRole("region", { name: "响应示例编辑区" });
  const choice = (name) => pane.getByRole("button", { name, exact: true });
  const body = pane.getByRole("textbox", { name: "响应示例正文" });
  const edit = choice("编辑");
  const add = choice("新建期望");
  const form = pane.getByRole("dialog", { name: "响应示例设置" });
  const name = form.getByRole("textbox", { name: "名称" });
  const status = form.getByRole("textbox", { name: "状态码" });
  const confirm = form.getByRole("button", { name: "确定" });
  const responseTab = page.locator('[data-response="examples"]');
  const ready = () => page.locator("#saved-state").textContent();
  const pick = (r) => page.locator(`.sidebar [data-request="${r.id}"]`).click();
  const active = (locator) =>
    locator.evaluate((el) => el === document.activeElement);
  const open = async (button) => {
    await button.press("Enter");
    await form.waitFor();
    assert.equal(await active(name), true);
  };
  try {
    const initial = page.locator(`.sidebar [data-request="${a.id}"]`);
    await page.goto(app.launchUrl);
    await initial.waitFor({ state: "visible", timeout: 10000 });
    assert.equal(startup.status("/mock-target.js"), 200);
  } catch {
    const startupError = await page
      .getByRole("heading", { name: "无法启动工作台", exact: true })
      .isVisible()
      .catch(() => false);
    throw Error(
      "Workbench startup did not expose the seeded request: " +
        JSON.stringify({
          ...startup.snapshot(),
          startupError,
        }),
    );
  }
  await pick(a);
  await page.locator('[data-mode="debug"]').click();
  await page.locator('.param-tabs [data-param="body"]').click();
  await responseTab.press("Enter");
  assert.equal(await ready(), "✓ 已保存");
  assert.equal(await choice("成功").getAttribute("aria-pressed"), "true");
  assert.equal(await choice("失败").isVisible(), true);
  assert.equal(await body.evaluate((el) => el.readOnly), true);
  assert.equal(await body.inputValue(), "");
  const geometry = {
    tools: await pane.locator(".http-debug-example-tools").boundingBox(),
    body: await body.boundingBox(),
  };
  console.log("HTTP_DEBUG_EXAMPLES_GEOMETRY", JSON.stringify(geometry));
  assert(Math.abs(geometry.tools.x - 371) <= 3);
  assert(Math.abs(geometry.tools.y - 639) <= 4);
  assert(Math.abs(geometry.body.y - 677) <= 4);
  assert(Math.abs(geometry.body.x + geometry.body.width - 1305) <= 3);
  await capture("empty-desktop");
  await open(edit);
  assert.equal(await name.inputValue(), "成功");
  assert.equal(await status.inputValue(), "200");
  await capture("metadata-desktop");
  await name.press("Escape");
  await form.waitFor({ state: "hidden" });
  assert.equal(await active(edit), true);
  assert.equal(await ready(), "✓ 已保存");
  await open(edit);
  await confirm.press("Enter");
  await form.waitFor({ state: "hidden" });
  assert.equal(await body.evaluate((el) => el.readOnly), false);
  assert.match(
    await pane.locator(".http-debug-example-format").textContent(),
    /纯文本/,
  );
  await body.fill('{"id":101}');
  await open(add);
  assert.equal(await status.inputValue(), "200");
  await name.fill("Review 404");
  await status.fill("404");
  await confirm.press("Enter");
  await form.waitFor({ state: "hidden" });
  assert.equal(await choice("成功").getAttribute("aria-pressed"), "true");
  assert.equal(await body.inputValue(), '{"id":101}');
  await choice("Review 404").press("Enter");
  assert.equal(await active(choice("Review 404")), true);
  await body.fill("<script>window.inertFixture=false</script>\nsample only");
  assert.equal(await page.evaluate(() => window.inertFixture), undefined);
  await body.fill("sample only");
  await capture("populated-desktop");

  await open(edit);
  const staleForm = await form.elementHandle();
  await name.fill("Not applied to owner");
  await page
    .locator(`.sidebar [data-request="${b.id}"]`)
    .evaluate((tab) => tab.click());
  await staleForm.evaluate((element) => {
    if (element.isConnected) throw Error("Expected a detached metadata form");
    element.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  assert.equal(await body.inputValue(), '{"id":7}');
  await body.fill("{ invalid");
  assert.equal(await body.getAttribute("aria-invalid"), "true");
  await page.locator("#save").click();
  await page
    .getByText("请修正或撤回无效的响应示例正文后再保存", { exact: true })
    .waitFor();
  await page.locator('[data-mode="mock"]').click();
  await page.locator('[data-edit-example="0"]').click();
  await page
    .getByText("请返回调试的响应示例，修正或撤回该示例的无效正文后再编辑", {
      exact: true,
    })
    .waitFor();
  assert.equal(await page.locator("#dialog").evaluate((el) => el.open), false);
  const dismissDelete = async (dialog) => {
    assert.match(dialog.message(), /未完成的正文草稿也将丢弃/);
    await dialog.dismiss();
  };
  const deleteDialog = page.waitForEvent("dialog");
  await Promise.all([
    deleteDialog.then(dismissDelete),
    page.locator('[data-delete-example="0"]').click(),
  ]);
  await page.locator('[data-edit-folder="Fixture folder"]').click();
  await page.locator("#folder-name").fill("Unapplied rename");
  await page.locator("#dialog-save").click();
  await page
    .getByText("请先修正或撤回无效的响应示例正文，再修改目录", {
      exact: true,
    })
    .waitFor();
  assert.equal(await page.locator("#dialog").evaluate((el) => el.open), true);
  await page.locator("#folder-name").press("Escape");
  await page.locator("#dialog").waitFor({ state: "hidden" });
  assert.equal(
    await page.locator('[data-edit-folder="Fixture folder"]').isVisible(),
    true,
  );
  assert.deepEqual(writes, []);
  assert.deepEqual(await app.store.get(owner.id), baseline);
  await page.locator('[data-mode="debug"]').click();
  await responseTab.click();
  assert.equal(await body.inputValue(), "{ invalid");
  assert.equal(await body.getAttribute("aria-invalid"), "true");
  await body.press("Escape");
  assert.equal(await body.inputValue(), '{"id":7}');
  assert.equal(await body.getAttribute("aria-invalid"), "false");
  await choice("Opaque XML").click();
  assert.equal(await body.evaluate((el) => el.readOnly), true);
  assert.equal(await edit.count(), 0);
  assert.equal(await body.inputValue(), "<fixture>unchanged</fixture>");
  await pick(a);
  await responseTab.click();
  assert.equal(await choice("Review 404").getAttribute("aria-pressed"), "true");
  assert.equal(await body.inputValue(), "sample only");
  await choice("成功").click();
  assert.equal(await body.inputValue(), '{"id":101}');
  await page.locator("#toast").waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 430, height: 830 });
  await responseTab.press("Enter");
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  await choice("Review 404").press("Enter");
  assert.equal(await body.inputValue(), "sample only");
  await open(edit);
  const anchored = await form.boundingBox();
  assert(anchored.x >= 8 && anchored.x + anchored.width <= 422);
  await name.press("Escape");
  await capture("populated-narrow");
  assert.deepEqual(await app.store.get(owner.id), baseline);
  assert.deepEqual(writes, []);
  assert.deepEqual(forbidden, []);

  await page.setViewportSize({ width: 1363, height: 1023 });
  allowSave = true;
  await page.locator("#save").click();
  await page
    .locator("#saved-state")
    .getByText("✓ 已保存", { exact: true })
    .waitFor();
  allowSave = false;
  const saved = await app.store.get(owner.id);
  assert.deepEqual(saved.requests[0].examples, [
    {
      name: "成功",
      status: 200,
      body: '{"id":101}',
      headers: { "content-type": "text/plain" },
    },
    {
      name: "Review 404",
      status: 404,
      body: "sample only",
      headers: { "content-type": "text/plain" },
    },
  ]);
  assert.deepEqual(saved.requests[1].examples, baseline.requests[1].examples);
  assert.deepEqual(saved.requests[0].responses, baseline.requests[0].responses);
  assert.deepEqual(saved.history, baseline.history);
  assert.equal(saved.settings.mockEnabled, baseline.settings.mockEnabled);
  assert.deepEqual(writes, ["PUT"]);
  assert.deepEqual(forbidden, []);
  assert.deepEqual(startup.snapshot().pageErrors, []);
  console.log(
    "HTTP_DEBUG_EXAMPLES_UI_PASS explicit local save, separate drafts and no dispatch",
  );
} finally {
  try {
    await browser?.close();
  } finally {
    await app?.close();
    await rm(home, { recursive: true, force: true });
  }
}
