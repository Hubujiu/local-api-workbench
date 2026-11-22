import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const evidence = process.env.LOAD_RESULT_OWNER_EVIDENCE;
const root = await mkdtemp("/tmp/workbench-load-result-owner-");
const app = await createApp({ root, port: 0 });
const received = [];
let held;
const fixture = createServer((req, res) => {
  received.push([req.method, req.url]);
  if (req.method !== "GET" || req.url !== "/owned-a" || held) {
    res.writeHead(404).end();
    return;
  }
  held = res;
  console.log("LOAD_OWNER_LOCAL_GET_HELD");
  fixture.emit("owner-request-held");
});
fixture.listen(0, "127.0.0.1");
await once(fixture, "listening");
let browser;
try {
  const project = await app.store.create("默认项目");
  const other = await app.store.create("Separate owner");
  const fixtureOrigin = "http://127.0.0.1:" + fixture.address().port;
  const request = (id, name, path) =>
    normalizeRequest({ id, name, url: fixtureOrigin + path, method: "GET" });
  project.requests = [
    request("load-a", "Synthetic owner A", "/owned-a"),
    request("load-b", "Synthetic owner B", "/unexpected-b"),
  ];
  other.requests = [
    request("load-a", "Same id, separate project", "/unexpected-project"),
  ];
  await app.store.save(project);
  await app.store.save(other);
  const revision = (await app.store.get(project.id)).configRevision;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
  });
  if (evidence) await mkdir(evidence, { recursive: true });
  const capture = (name) =>
    evidence &&
    page.screenshot({
      path: join(evidence, "load-owner-" + name + ".png"),
      clip: { x: 0, y: 0, width: 1363, height: 980 },
      animations: "disabled",
    });
  const origin = new URL(app.launchUrl).origin;
  const blocked = [];
  const attempts = [];
  const errors = [];
  let authorized = false;
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error("LOAD_OWNER_PAGE_ERROR", error.message);
  });
  page.on("requestfailed", (request) => {
    if (request.method() === "POST")
      console.error("LOAD_OWNER_POST_FAILED", request.failure()?.errorText);
  });
  await page.route("**/*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin && request.method() === "GET")
      return route.continue();
    if (
      authorized &&
      url.origin === origin &&
      url.pathname === "/api/projects/" + project.id + "/load" &&
      request.method() === "POST"
    ) {
      authorized = false;
      attempts.push(request.postDataJSON());
      console.log("LOAD_OWNER_APP_POST", {
        count: attempts.at(-1).count,
        concurrency: attempts.at(-1).concurrency,
        method: attempts.at(-1).request.method,
        owner: attempts.at(-1).request.id,
      });
      return route.continue();
    }
    blocked.push(request.method() + " " + url.pathname);
    console.error("LOAD_OWNER_BLOCKED_ROUTE", request.method(), url.pathname);
    return route.abort();
  });
  const mode = page.locator('[data-mode="load"]');
  const projects = page.locator("#project-select");
  const result = page.getByRole("region", { name: "压测结果" });
  const idle = result.getByText("暂无压测结果", { exact: true });
  const actual = result.locator(".grid-stats");
  const start = page.locator("#load-run");
  const open = (id) => page.locator(`[data-request="${id}"]`).click();
  await page.goto(app.launchUrl);
  await projects.selectOption(project.id);
  await page
    .getByRole("button", { name: /Synthetic owner A/ })
    .first()
    .waitFor();
  await open("load-a");
  await mode.click();
  await page.locator("#load-count").fill("1");
  await page.locator("#load-concurrency").fill("1");
  await idle.waitFor();
  const readiness = await page.evaluate(() => {
    const button = document.querySelector("#load-run");
    const box = button.getBoundingClientRect();
    const hit = document.elementFromPoint(
      box.x + box.width / 2,
      box.y + box.height / 2,
    );
    return {
      request: document
        .querySelector('[data-open-tab="load-a"]')
        ?.textContent?.trim(),
      method: document.querySelector("#method")?.value,
      status: document.querySelector("#saved-state")?.textContent,
      count: document.querySelector("#load-count")?.value,
      concurrency: document.querySelector("#load-concurrency")?.value,
      mode: document.querySelector("#load-mode")?.value,
      disabled: button.disabled,
      pointerTarget: hit?.id || hit?.tagName || null,
    };
  });
  console.log("LOAD_OWNER_READY", JSON.stringify(readiness));
  assert.deepEqual(
    [
      readiness.method,
      readiness.status,
      readiness.count,
      readiness.concurrency,
      readiness.mode,
      readiness.disabled,
    ],
    ["GET", "✓ 已保存", "1", "1", "count", false],
  );
  await capture("before");
  let confirmed = false;
  page.once("dialog", (dialog) => {
    confirmed =
      dialog.type() === "confirm" && /有权执行此次压测/.test(dialog.message());
    console.log("LOAD_OWNER_CONFIRM", { expected: confirmed });
    return confirmed ? dialog.accept() : dialog.dismiss();
  });
  const heldRequest = once(fixture, "owner-request-held").then(() => ({
    held: true,
  }));
  // Manage both outcomes at creation, so an action failure cannot be masked
  // by an unhandled response waiter.
  const completed = page
    .waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          "/api/projects/" + project.id + "/load" &&
        response.request().method() === "POST",
    )
    .then(
      (response) => ({ response }),
      (error) => ({ error }),
    );
  authorized = true;
  try {
    await start.click({ timeout: 12000 });
    console.log("LOAD_OWNER_START_CLICKED", {
      confirmed,
      posts: attempts.length,
    });
    assert(
      confirmed,
      "The genuine pressure-run permission confirmation was not accepted",
    );
    const first = await Promise.race([heldRequest, completed]);
    if (first.error) throw first.error;
    assert(
      first.held,
      "Load ended before the local fixture was held: " +
        first.response?.status(),
    );
  } catch (error) {
    const toast = (await page.locator("#toast").isVisible())
      ? await page.locator("#toast").textContent()
      : null;
    console.error("LOAD_OWNER_START_DIAGNOSTICS", {
      confirmed,
      posts: attempts.length,
      localGets: received.length,
      toast,
    });
    throw error;
  }
  assert(await projects.isDisabled());
  await open("load-b");
  await idle.waitFor();
  assert(await start.isDisabled());
  held
    .writeHead(201, { "Content-Type": "application/json" })
    .end('{"fixture":true}');
  const { response: receipt, error } = await completed;
  if (error) throw error;
  console.log("LOAD_OWNER_APP_RESPONSE", receipt.status());
  assert.equal(receipt.status(), 200);
  const payload = await receipt.json();
  assert.equal(payload.mainRequests, 1);
  assert.equal(payload.results[0].status, 201);
  await page.waitForFunction(
    () => !document.querySelector("#load-run").disabled,
  );
  // A has completed while B is the visible interface. B must still be idle.
  await idle.waitFor();
  assert.equal(await actual.count(), 0);
  await capture("b-idle");

  await open("load-a");
  await actual.waitFor();
  assert.equal(
    JSON.parse(await result.locator("pre").textContent())[0].status,
    201,
  );
  await capture("a-actual");
  await open("load-b");
  await idle.waitFor();
  await projects.selectOption(other.id);
  await page
    .locator('[data-request="load-a"]')
    .getByText("Same id, separate project", { exact: true })
    .waitFor();
  await idle.waitFor();
  await projects.selectOption(project.id);
  await page
    .locator('[data-request="load-a"]')
    .getByText("Synthetic owner A", { exact: true })
    .waitFor();
  await idle.waitFor();

  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].count, 1);
  assert.equal(attempts[0].request.id, "load-a");
  assert.deepEqual(received, [["GET", "/owned-a"]]);
  assert.equal((await app.store.get(project.id)).configRevision, revision);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  console.log(
    "LOAD_RESULT_OWNERSHIP_PASS one-loopback/delayed-sibling/return-owner/project-reset",
  );
} finally {
  if (held && !held.writableEnded) held.end();
  await browser?.close();
  await app.close();
  await new Promise((resolve, reject) =>
    fixture.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(root, { recursive: true, force: true });
}
