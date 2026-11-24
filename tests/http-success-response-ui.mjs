import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRequest } from "../src/core.mjs";
import { createApp } from "../src/server.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const home = await mkdtemp(join(tmpdir(), "workbench-success-response-"));
const raw =
  ' \r\n{"id":101,"username":"visual-fixture","status":"created"}\r\n';
const hits = [];
const peer = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    hits.push({
      method: req.method,
      url: req.url,
      body: Buffer.concat(chunks).toString(),
    });
    res.writeHead(req.method === "POST" && req.url === "/users" ? 201 : 404, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(raw),
    });
    res.end(raw);
  });
});
let app, browser;
try {
  peer.listen(0, "127.0.0.1");
  await once(peer, "listening");
  app = await createApp({ root: home, port: 0 });
  const owner = await app.store.create("默认项目");
  const body = JSON.stringify(
    {
      id: 0,
      username: "username",
      firstName: "",
      lastName: "",
      email: "",
      password: "",
      phone: "",
      userStatus: 0,
    },
    null,
    4,
  );
  const url = "http://127.0.0.1:" + peer.address().port + "/users";
  owner.requests = [
    normalizeRequest({
      id: "local-created-user",
      name: "创建用户",
      method: "POST",
      url,
      folder: "示例接口",
      bodyType: "json",
      body,
    }),
    normalizeRequest({
      id: "unsent-owner",
      name: "未发送",
      url: "",
      bodyType: "none",
    }),
  ];
  const before = await app.store.save(owner);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1188, height: 848 },
    deviceScaleFactor: 1,
    locale: "zh-CN",
    colorScheme: "light",
  });
  page.setDefaultTimeout(7500);
  const origin = new URL(app.launchUrl).origin;
  const execPath = "/api/projects/" + owner.id + "/execute";
  const blocked = [],
    errors = [],
    metrics = {};
  let approved = false,
    browserExecutes = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((id) => {
    sessionStorage.setItem("project", id);
    localStorage.setItem("theme", "light");
    localStorage.setItem("response-layout", "stacked");
  }, owner.id);
  await page.route("**/*", (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.origin === origin && req.method() === "GET")
      return route.continue();
    if (
      approved &&
      browserExecutes === 0 &&
      url.origin === origin &&
      req.method() === "POST" &&
      url.pathname === execPath
    ) {
      browserExecutes++;
      return route.continue();
    }
    blocked.push([req.method(), url.pathname]);
    return route.abort();
  });
  await page.goto(app.launchUrl);
  await page.locator('#tree [data-request="local-created-user"]').click();
  const editor = page.locator('.editor[data-editor-mode="debug"]');
  const bodyTab = editor.locator('.param-tabs [data-param="body"]');
  const responseTab = (name) =>
    editor.locator(`.response-tabs [data-response="${name}"]`);
  const viewer = editor.locator(".http-success-response");
  const toolbar = viewer.getByRole("group", { name: "响应显示格式" });
  const code = viewer.locator("#http-response-text");
  const rawAction = toolbar.getByRole("button", { name: "原生", exact: true });
  const pretty = toolbar.getByRole("button", { name: "美化", exact: true });
  const response = editor.locator(".response");
  const theme = page.locator("#theme");
  const evidence = process.env.HTTP_SUCCESS_RESPONSE_EVIDENCE;
  const capture = async (name, narrow = false) => {
    if (!evidence) return;
    await mkdir(evidence, { recursive: true });
    await page.mouse.move(narrow ? 422 : 1170, 84);
    await page.screenshot({
      path: join(evidence, name + ".png"),
      animations: "disabled",
      caret: "hide",
      ...(narrow ? {} : { clip: { x: 0, y: 0, width: 1188, height: 812 } }),
    });
  };
  const boxes = async () =>
    viewer.evaluate((root) => {
      const rect = (el) => {
        const { x, y, width, height } = el.getBoundingClientRect();
        return [x, y, width, height].map(Math.round);
      };
      return {
        response: rect(root.closest(".response")),
        toolbar: rect(root.querySelector(".http-success-response-toolbar")),
        gutter: rect(root.querySelector(".http-success-response-gutter")),
        code: rect(root.querySelector("#http-response-text")),
        lineHeight: getComputedStyle(root.querySelector("#http-response-text"))
          .lineHeight,
      };
    });

  await bodyTab.press("Enter");
  assert.equal(await viewer.count(), 0);
  await editor.locator("#body-code").waitFor();
  approved = true;
  const [reply] = await Promise.all([
    page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === execPath &&
        res.request().method() === "POST",
    ),
    page.locator("#send").click(),
  ]);
  approved = false;
  assert.equal(reply.status(), 200);
  const receipt = await reply.json();
  assert.equal(receipt.status, 201);
  assert.equal(receipt.body, raw);
  assert.equal(receipt.size, Buffer.byteLength(raw));
  await viewer.waitFor();
  await response
    .locator(".metrics .success")
    .getByText("201", { exact: true })
    .waitFor();
  assert.deepEqual(
    (await response.locator(".metrics").innerText())
      .split(/\s+/)
      .slice(1)
      .join(" "),
    `${receipt.duration} ms ${receipt.size} B`,
  );
  assert.equal(await pretty.getAttribute("aria-pressed"), "true");
  assert.deepEqual(JSON.parse(await code.textContent()), {
    id: 101,
    username: "visual-fixture",
    status: "created",
  });
  assert.equal(await code.locator("span.syntax-number").textContent(), "101");
  metrics.light = await boxes();
  console.log("HTTP_SUCCESS_RESPONSE_GEOMETRY", JSON.stringify(metrics.light));
  await capture("response-light-workbench");
  assert.equal(metrics.light.toolbar[3], 56);
  assert.equal(metrics.light.gutter[2], 62);
  assert.equal(metrics.light.lineHeight, "16px");

  await rawAction.press("Enter");
  assert.equal(await rawAction.getAttribute("aria-pressed"), "true");
  assert.equal(
    await code.textContent(),
    raw,
    "Raw preserves decoded CRLF and whitespace",
  );
  assert.equal(await code.locator("span").count(), 0);
  await responseTab("headers").press("Enter");
  assert.equal(await viewer.count(), 0);
  await responseTab("body").press("Enter");
  assert.equal(await code.textContent(), raw);
  await pretty.press("Enter");
  await theme.click();
  await page.locator(".response-body").evaluate((node) => {
    node.scrollTop = 0;
    node.ownerDocument.scrollingElement.scrollTop = 0;
  });
  assert.equal(await pretty.getAttribute("aria-pressed"), "true");
  assert.deepEqual(await boxes(), metrics.light);
  await capture("response-dark-workbench");

  await page.setViewportSize({ width: 430, height: 830 });
  await rawAction.press("Enter");
  assert.equal(await code.textContent(), raw);
  assert(
    await rawAction.evaluate((button) => button === document.activeElement),
  );
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  await viewer.getByRole("region", { name: "响应正文" }).focus();
  assert(
    await viewer
      .getByRole("region", { name: "响应正文" })
      .evaluate((node) => node === document.activeElement),
  );
  await capture("response-narrow-workbench", true);

  await page.setViewportSize({ width: 1188, height: 848 });
  await page.locator('#tree [data-request="unsent-owner"]').click();
  assert.equal(await viewer.count(), 0);
  await page.locator('#tree [data-request="local-created-user"]').click();
  assert.equal(await code.textContent(), raw);
  assert.equal(browserExecutes, 1);
  assert.deepEqual(hits, [{ method: "POST", url: "/users", body }]);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  const saved = await app.store.get(owner.id);
  assert.equal(saved.configRevision, before.configRevision);
  assert.deepEqual(saved.requests, before.requests);
  if (evidence)
    await writeFile(
      join(evidence, "response-metrics.json"),
      JSON.stringify(metrics, null, 2),
    );
  console.log(
    "HTTP_SUCCESS_RESPONSE_UI_PASS 201/decoded-raw/lexical-pretty/light+dark/430/focus/one-loopback/no-definition-writes",
  );
} finally {
  await browser?.close();
  await app?.close();
  if (peer.listening) await new Promise((resolve) => peer.close(resolve));
  await rm(home, { recursive: true, force: true });
}
