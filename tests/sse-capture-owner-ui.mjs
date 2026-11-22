import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeProtocol } from "../src/protocol-definitions.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const root = await mkdtemp(
  join(process.env.SSE_CAPTURE_TEST_ROOT || tmpdir(), "sse-owner-ui-"),
);
const held = () => {
  let release;
  return { promise: new Promise((resolve) => (release = resolve)), release };
};
const posted = [];
const breaches = [];
const refused = [];
const pendingDisconnect = held();
const first = held();
const second = held();
let app, browser;
try {
  app = await createApp({ root, port: 0 });
  const project = await app.store.create("采集回执合成项目");
  const urls = ["http://127.0.0.1:1/events-a", "http://127.0.0.1:1/events-b"];
  const updatedUrl = "http://127.0.0.1:1/events-b-retargeted";
  project.protocols = ["a", "b"].map((id, i) =>
    normalizeProtocol({
      id,
      name: `SSE fixture ${id}`,
      type: "sse",
      url: urls[i],
    }),
  );
  await app.store.save(project);
  const baseline = await app.store.get(project.id);
  const other = await app.store.create("另一合成项目");
  other.protocols = [structuredClone(project.protocols[1])];
  await app.store.save(other);
  const otherBaseline = await app.store.get(other.id);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
    locale: "zh-CN",
  });
  page.setDefaultTimeout(7000);
  const origin = new URL(app.launchUrl).origin;
  const routePath = "/api/projects/" + project.id;
  let reads = 0,
    saves = 0;
  page.on("pageerror", (error) => refused.push(error.message));
  await page.addInitScript((id) => {
    localStorage.setItem("theme", "light");
    sessionStorage.setItem("project", id);
  }, project.id);
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.origin === origin) {
      if (method === "POST" && url.pathname === routePath + "/protocol") {
        const input = request.postDataJSON();
        posted.push(["capture", input]);
        const fixture = posted.filter(([name]) => name === "capture").length;
        if (fixture === 1 || fixture === 2) {
          const response = await (fixture === 1
            ? first.promise
            : second.promise);
          return route.fulfill(response);
        }
      }
      if (method === "POST" && url.pathname === "/api/cancel") {
        posted.push(["cancel", request.postDataJSON()]);
        await pendingDisconnect.promise;
        return route.fulfill({ json: { ok: true } });
      }
      if (method === "PUT" && url.pathname === routePath && saves === 0) {
        saves += 1;
        const { protocols } = request.postDataJSON();
        assert.equal(protocols.find((item) => item.id === "a").url, urls[0]);
        assert.equal(protocols.find((item) => item.id === "b").url, updatedUrl);
        return route.continue();
      }
      if (method === "GET" && url.pathname === routePath + "/protocol-runs") {
        assert.equal(url.search, "?type=sse");
        reads += 1;
        const input = posted.filter(([name]) => name === "capture")[1][1];
        const record = {
          id: "record-b",
          type: "sse",
          definition: { type: "sse", url: urls[1] },
          runId: input.runId,
          status: "cancelled",
          result: null,
          error: "old-capture-payload-fixture",
        };
        return route.fulfill({
          json:
            reads === 1
              ? [
                  { ...record, runId: "unrelated" },
                  {
                    ...record,
                    definition: { ...record.definition, url: urls[0] },
                  },
                ]
              : [
                  record,
                  {
                    ...record,
                    definition: { ...record.definition, url: updatedUrl },
                  },
                ],
        });
      }
      if (method === "GET" && !url.pathname.endsWith("/protocol-runs"))
        return route.continue();
    }
    breaches.push([method, url.origin, url.pathname]);
    return route.abort();
  });
  await page.goto(app.launchUrl);
  const select = (id) => page.locator(`[data-protocol-id="${id}"]`).click();
  const start = page.locator("#protocol-run");
  const cancel = page.locator("#cancel");
  const result = page.locator("#protocol-result");
  const check = page.locator("#sse-capture-check");
  const capture = async (state) => {
    const prefix = process.env.SSE_CAPTURE_EVIDENCE;
    if (!prefix) return;
    await page.screenshot({
      path: prefix + "-" + state + ".png",
      caret: "hide",
      animations: "disabled",
    });
  };
  const status = (text) => page.getByText(text, { exact: true }).waitFor();

  await select("a");
  assert.equal(await cancel.isEnabled(), false);
  const waitForCaptureA = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().endsWith(routePath + "/protocol"),
  );
  await start.press("Enter");
  const inputA = (await waitForCaptureA).postDataJSON();
  assert.equal(inputA.url, urls[0]);
  assert.equal(inputA.type, "sse");
  assert.equal(inputA.method, undefined);
  assert.equal(inputA.body, undefined);
  await status("正在采集 SSE 事件…");
  assert.equal(await cancel.isEnabled(), true);
  await capture("running-a");
  await select("b");
  assert.equal(await cancel.isEnabled(), false);
  assert.equal(await start.isEnabled(), false);
  first.release({
    json: {
      runId: inputA.runId,
      recordSaved: true,
      recordId: "record-a",
      attemptedRecordId: "record-a",
      status: 200,
      events: [{ data: "only owned A" }],
    },
  });
  await start.waitFor();
  await page.waitForFunction(
    () => !document.querySelector("#protocol-run")?.disabled,
  );
  assert.equal(await result.textContent(), "");
  await select("a");
  await status("采集完成 · 本机记录已保存");
  assert.match(await result.textContent(), /only owned A/);
  await capture("completed-a");
  await select("b");
  const waitForCaptureB = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().endsWith(routePath + "/protocol"),
  );
  await start.click();
  const inputB = (await waitForCaptureB).postDataJSON();
  assert.equal(inputB.url, urls[1]);
  assert.notEqual(inputA.runId, inputB.runId);
  await cancel.click();
  await status("已请求断开，正在等待本机结果…");
  assert.equal(await cancel.isEnabled(), false);
  await capture("stopping-b");
  pendingDisconnect.release();
  second.release({
    status: 400,
    json: {
      runId: inputB.runId,
      recordSaved: true,
      recordId: "record-b",
      attemptedRecordId: "record-b",
      error: "Synthetic operation aborted",
    },
  });
  await status("结果待核对；没有记录不代表未执行，请勿重发。");
  assert.equal(await start.isEnabled(), false);
  assert.equal(await result.textContent(), "");
  const switchTo = async (id) => {
    await page.locator("#project-select").selectOption(id);
    await page.waitForFunction(
      (expected) =>
        document.querySelector("#project-select option[selected]")?.value ===
        expected,
      id,
    );
    await select("b");
  };
  await switchTo(other.id);
  assert.equal(await check.isVisible(), false);
  assert.equal(await start.isEnabled(), true);
  assert.equal(await result.textContent(), "");
  await switchTo(project.id);
  await status("结果待核对；没有记录不代表未执行，请勿重发。");
  await check.click();
  const missedText =
    "未核对到这一笔采集的已保存记录；不能据此判断未执行，请勿重发。";
  const missed = page.getByText(missedText, { exact: true });
  await missed.waitFor();
  assert.equal(
    await page.locator("#sse-capture-status").textContent(),
    missedText,
  );
  assert.doesNotMatch(
    await page.locator("#toast").textContent(),
    /未核对到这一笔/,
  );
  assert.equal(await start.isEnabled(), false);
  const target = page.locator("#protocol-url");
  const previousTarget = page.locator("#sse-capture-target-note");
  const savedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().endsWith(routePath),
  );
  assert.equal(await previousTarget.isVisible(), false);
  await target.fill(updatedUrl);
  await page.locator("#save-protocol").click();
  assert.equal((await savedResponse).ok(), true);
  await previousTarget.waitFor();
  assert.match(
    await previousTarget.textContent(),
    /之前的采集.*不代表当前地址已执行/,
  );
  assert.equal(await target.inputValue(), updatedUrl);
  assert.equal(await start.isEnabled(), false);
  assert.equal(await check.isEnabled(), true);
  assert.equal(await missed.count(), 1);
  assert.equal(reads, 1, "saving does not check/replay");
  await page.setViewportSize({ width: 430, height: 900 });
  await check.press("Enter");
  await status("采集已取消 · 本机记录已保存");
  assert.equal(await previousTarget.isVisible(), true);
  assert.equal(await result.textContent(), "");
  assert.equal(
    await missed.count(),
    0,
    "settled UI must not show stale reconciliation feedback",
  );
  assert.doesNotMatch(
    await page.locator("#toast").textContent(),
    /未核对到这一笔/,
  );
  if (process.env.SSE_CAPTURE_EVIDENCE)
    await page.locator("#toast").waitFor({ state: "hidden" });
  await capture("cancelled-b-narrow");
  assert.equal(await check.isVisible(), false);
  assert.equal(await start.isEnabled(), true);
  assert.equal(
    await start.evaluate((element) => element === document.activeElement),
    true,
  );
  assert.equal(
    await page
      .locator(".selected-sse-workbench")
      .evaluate((node) => node.scrollWidth <= node.clientWidth),
    true,
  );
  assert.equal(reads, 2);
  assert.deepEqual(
    posted.map(([action]) => action),
    ["capture", "capture", "cancel"],
  );
  assert.deepEqual(posted[2][1], { id: inputB.runId });
  const after = await app.store.get(project.id);
  assert.equal(saves, 1);
  assert.equal(after.revision, baseline.revision + 1);
  assert.equal(after.configRevision, baseline.configRevision + 1);
  assert.deepEqual(
    after.protocols,
    baseline.protocols.map((item) =>
      item.id === "b" ? { ...item, url: updatedUrl } : item,
    ),
  );
  assert.deepEqual(after.protocolRuns, baseline.protocolRuns);
  assert.deepEqual(await app.store.get(other.id), otherBaseline);
  assert.deepEqual(refused, []);
  assert.deepEqual(breaches, []);
  console.log(
    "SSE_CAPTURE_OWNER_UI_PASS held receipts, one explicit target save, no SSE dispatch",
  );
} finally {
  first.release({ status: 500, json: {} });
  second.release({ status: 500, json: {} });
  pendingDisconnect.release();
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
