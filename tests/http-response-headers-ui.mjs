import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRequest } from "../src/core.mjs";
import { createApp } from "../src/server.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const home = await mkdtemp(join(tmpdir(), "workbench-http-response-headers-"));
const literal = "<b>0007</b> & literal";
const combined = '0007, "a,b", tail';
const long = "callback-" + "0123456789".repeat(14);
const cookies = ["first=0007; Path=/", "second=two; Path=/"];
const hits = [];
const target = createServer((req, res) => {
  hits.push(req.url);
  res.sendDate = false;
  const body = req.url === "/created" ? "created" : "forbidden";
  res.writeHead(req.url === "/created" ? 201 : 403, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    connection: "close",
    "x-literal": literal,
    "x-combined": combined,
    ...(req.url === "/created"
      ? { "set-cookie": cookies }
      : { "x-long": long, "x-request-id": "synthetic-rejected" }),
  });
  res.end(body);
});
let app, browser;
try {
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  app = await createApp({ root: home, port: 0 });
  const owner = await app.store.create("响应头验证");
  const endpoint = "http://127.0.0.1:" + target.address().port;
  owner.requests = [
    normalizeRequest({
      id: "created",
      name: "Verification",
      url: endpoint + "/created",
      afterScript:
        'pm.response.setCode(299); pm.response.setBody("script-overlay");',
    }),
    normalizeRequest({
      id: "forbidden",
      name: "Forbidden",
      url: endpoint + "/forbidden",
    }),
    normalizeRequest({ id: "unsent", name: "未发送", url: "" }),
  ];
  const before = await app.store.save(owner);
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
  await page.addInitScript((ownerId) => {
    sessionStorage.setItem("project", ownerId);
    localStorage.setItem("theme", "light");
    localStorage.setItem("response-layout", "stacked");
  }, owner.id);
  let allowedId;
  const actions = [],
    blocked = [],
    pageErrors = [];
  const origin = new URL(app.launchUrl).origin;
  const executePath = "/api/projects/" + owner.id + "/execute";
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/*", (route) => {
    const req = route.request();
    const { origin: requestOrigin, pathname } = new URL(req.url());
    if (requestOrigin === origin && req.method() === "GET")
      return route.continue();
    if (
      requestOrigin === origin &&
      req.method() === "POST" &&
      pathname === executePath &&
      allowedId &&
      req.postDataJSON()?.request?.id === allowedId
    ) {
      actions.push(allowedId);
      allowedId = undefined;
      return route.continue();
    }
    blocked.push([req.method(), pathname]);
    return route.abort();
  });
  await page.goto(app.launchUrl);
  const pick = (id) => page.locator(`#tree [data-request="${id}"]`).click();
  const editor = page.locator('.editor[data-editor-mode="debug"]');
  const response = editor.locator(".response");
  const select = (name) =>
    response.locator(`.response-tabs [data-response="${name}"]`);
  const table = response.getByRole("table", {
    name: "网络响应头",
    exact: true,
  });
  const row = (name) =>
    table.locator("tbody tr").filter({
      has: page.getByRole("rowheader", { name, exact: true }),
    });
  const readRows = () =>
    table
      .locator("tbody tr")
      .evaluateAll((rows) =>
        rows.map((tr) => Array.from(tr.cells, (cell) => cell.textContent)),
      );
  const evidence = process.env.HTTP_RESPONSE_HEADERS_EVIDENCE;
  const capture = async (name) => {
    if (!evidence) return;
    await mkdir(evidence, { recursive: true });
    await page.screenshot({
      path: join(evidence, `http-response-headers-${name}.png`),
      caret: "hide",
      animations: "disabled",
    });
  };
  const send = async (id, status) => {
    allowedId = id;
    const [reply] = await Promise.all([
      page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname === executePath &&
          res.request().method() === "POST",
      ),
      editor.locator("#send").click(),
    ]);
    assert.equal(reply.status(), 200);
    const receipt = await reply.json();
    assert.equal(receipt.status, status);
    await response
      .locator(`.metrics .${status >= 400 ? "failed" : "success"}`)
      .getByText(String(status), { exact: true })
      .waitFor();
    return receipt;
  };
  const verify = async (record) => {
    await select("headers").press("Enter");
    await table.waitFor();
    assert.equal(await select("headers").getAttribute("aria-pressed"), "true");
    assert.equal(
      await select("headers").evaluate((el) => document.activeElement === el),
      true,
    );
    assert.deepEqual(await table.getByRole("columnheader").allTextContents(), [
      "参数名",
      "参数值",
    ]);
    const expected = Object.entries(record.headers).flatMap(([name, v]) =>
      (Array.isArray(v) ? v : [v]).map((value) => [name, value]),
    );
    assert.deepEqual(await readRows(), expected);
    assert.equal(
      await select("headers").textContent(),
      `响应头 (${expected.length})`,
    );
    assert.deepEqual(
      (await response.locator(".metrics > span").allTextContents()).map(
        (item) => item.trim(),
      ),
      [String(record.status), `${record.duration} ms`, `${record.size} B`],
    );
    assert.equal(await row("x-literal").locator("td").textContent(), literal);
    assert.equal(await row("x-literal").locator("td b").count(), 0);
    assert.equal(await row("x-combined").locator("td").textContent(), combined);
    assert.equal(await table.getByRole("button").count(), 0);
  };

  await pick("created");
  await editor.locator('[data-param="body"]').press("Enter");
  await select("headers").press("Enter");
  assert.equal(await select("headers").textContent(), "响应头");
  assert.equal(await table.count(), 0);
  assert.equal(
    await response.getByText("暂无数据", { exact: true }).isVisible(),
    true,
  );
  const success = await send("created", 201);
  assert.equal(success.scriptResponse?.status, 299, success.error);
  await verify(success);
  assert.deepEqual(
    await row("set-cookie").locator("td").allTextContents(),
    cookies,
  );
  assert.equal(
    await response.getByText("script-overlay", { exact: true }).count(),
    0,
  );
  await capture("201-desktop");
  await select("scriptResponse").press("Enter");
  assert.equal(
    await response.locator("#response-script-view").textContent(),
    "script-overlay",
  );
  await verify(success);

  await pick("forbidden");
  assert.equal(await table.count(), 0);
  const error = await send("forbidden", 403);
  await verify(error);
  const geometry = await table.evaluate((el) => {
    const box = el
      .closest(".http-response-header-scroll")
      .getBoundingClientRect();
    const header = el.tHead.rows[0];
    const first = el.tBodies[0].rows[0];
    const value = header.cells[1];
    const valueStart =
      value.getBoundingClientRect().x +
      parseFloat(getComputedStyle(value).paddingLeft);
    return {
      x: box.x,
      y: box.y,
      width: box.width,
      head: header.getBoundingClientRect().height,
      row: first.getBoundingClientRect().height,
      valueStart,
    };
  });
  console.log("HTTP_RESPONSE_HEADERS_GEOMETRY", JSON.stringify(geometry));
  await capture("403-desktop");
  const near = (value, expected, tolerance = 3) =>
    assert(
      Math.abs(value - expected) <= tolerance,
      JSON.stringify({ value, expected, geometry }),
    );
  near(geometry.x, 371);
  near(geometry.width, 976);
  near(geometry.head, 37);
  near(geometry.row, 37);
  near(geometry.valueStart, 624);

  await page.setViewportSize({ width: 430, height: 830 });
  await page.locator("#theme").press("Enter");
  assert.equal(
    await page.evaluate(() => document.body.classList.contains("dark")),
    true,
  );
  await verify(error);
  const longCell = row("x-long").locator("td");
  await longCell.scrollIntoViewIfNeeded();
  assert.equal(await longCell.textContent(), long);
  const size = await longCell.evaluate((cell) => {
    const el = cell.closest(".http-response-header-scroll");
    return {
      tableWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      docWidth: document.documentElement.scrollWidth,
      cellHeight: cell.getBoundingClientRect().height,
    };
  });
  assert.equal(size.tableWidth, size.scrollWidth);
  assert.equal(size.docWidth, 430);
  assert(size.cellHeight > 37, "Long values wrap as selectable text");
  await capture("403-narrow-dark");

  await pick("unsent");
  await select("headers").press("Enter");
  assert.equal(await table.count(), 0);
  assert.equal(await select("headers").textContent(), "响应头");
  assert.equal(await response.locator(".metrics > span").count(), 0);
  assert.deepEqual(hits, ["/created", "/forbidden"]);
  assert.deepEqual(actions, ["created", "forbidden"]);
  assert.deepEqual(blocked, []);
  assert.deepEqual(pageErrors, []);
  const saved = await app.store.get(owner.id);
  assert.deepEqual(saved.requests, before.requests);
  assert.equal(saved.history.length, before.history.length + 2);
  console.log(
    "HTTP_RESPONSE_HEADERS_UI_PASS actual 201 and 403, projection without script data, keyboard, no config writes",
  );
} finally {
  try {
    await browser?.close();
  } finally {
    await app?.close();
    await new Promise((resolve) => target.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
}
