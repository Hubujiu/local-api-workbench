import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeProtocol } from "../src/protocol-definitions.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const root = await mkdtemp(join(tmpdir(), "workbench-sse-save-ui-"));
let hits = 0;
const target = createServer((_request, response) => {
  hits++;
  response.end("fixture should not be reached");
});
let app, browser;
try {
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  const url = "http://127.0.0.1:" + target.address().port + "/events";
  app = await createApp({ root, port: 0 });
  const project = await app.store.create("默认项目");
  const body = "private fixture text {{local_fixture}}";
  project.protocols = [
    normalizeProtocol({
      id: "advanced-sse",
      name: "Saved advanced SSE",
      type: "sse",
      url,
      folder: "Synthetic folder",
      method: "POST",
      body,
      templateMode: "variables",
      handshake: {
        headers: { "content-type": "text/plain" },
        requiredHeaders: ["authorization", "x-fixture"],
      },
      duration: 4321,
    }),
  ];
  await app.store.save(project);
  const baseline = await app.store.get(project.id);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
  });
  page.setDefaultTimeout(8500);
  const origin = new URL(app.launchUrl).origin;
  const projectRoute = "/api/projects/" + project.id;
  const allowedWrites = [],
    blocked = [],
    errors = [];
  let permit = false;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const req = route.request();
    const destination = new URL(req.url());
    if (destination.origin === origin && req.method() === "GET")
      return route.continue();
    if (
      destination.origin === origin &&
      destination.pathname === projectRoute &&
      req.method() === "PUT" &&
      permit
    ) {
      permit = false;
      allowedWrites.push(req.postDataJSON());
      return route.continue();
    }
    blocked.push([req.method(), destination.pathname]);
    return route.abort();
  });
  const row = page.locator('[data-protocol-id="advanced-sse"]');
  const editor = page.locator(".selected-sse-workbench");
  const name = editor.locator("#protocol-name");
  const address = editor.locator("#protocol-url");
  const transport = editor.locator("#protocol-type");
  const save = editor.locator("#save-protocol");
  const toast = page.locator("#toast");
  const reject = async () => {
    await toast.waitFor({ state: "hidden" });
    await save.click();
    await toast.getByText(/原定义已保留/).waitFor();
    assert.deepEqual(await app.store.get(project.id), baseline);
    assert.equal(hits, 0);
    assert.deepEqual(allowedWrites, []);
    assert.deepEqual(blocked, []);
    assert(!(await editor.innerText()).includes(body));
  };

  await page.goto(app.launchUrl);
  await row.click();
  await editor.waitFor();
  assert.equal(await name.inputValue(), "Saved advanced SSE");
  assert.equal(await address.inputValue(), url);
  assert(!(await page.content()).includes(body));
  await name.fill("Renamed in local fixture");
  await address.fill(url + "?would-change-target=1");
  await reject();
  await address.fill(url);
  await transport.selectOption("websocket");
  await reject();
  await transport.selectOption("sse");
  assert.equal(await name.inputValue(), "Renamed in local fixture");
  permit = true; // The browser has exactly one allowed mutation, the user gesture below.
  const [receipt] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.request().method() === "PUT" &&
        new URL(r.url()).pathname === projectRoute,
    ),
    save.press("Enter"),
  ]);
  assert.equal(receipt.status(), 200);
  await toast.getByText("已保存到本地", { exact: true }).waitFor();
  assert.equal(allowedWrites.length, 1);
  assert.deepEqual(allowedWrites[0].protocols[0], {
    ...baseline.protocols[0],
    name: "Renamed in local fixture",
    port: 0,
  });
  const reloaded = await app.store.get(project.id);
  assert.equal(reloaded.configRevision, baseline.configRevision + 1);
  assert.deepEqual(reloaded.protocols, [
    { ...baseline.protocols[0], name: "Renamed in local fixture" },
  ]);
  assert.deepEqual(reloaded.history, baseline.history);

  await page.reload();
  await row.click();
  assert.equal(await name.inputValue(), "Renamed in local fixture");
  assert.equal(await address.inputValue(), url);
  assert(!(await page.content()).includes(body));
  assert.equal(hits, 0);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  console.log(
    "SSE_DEFINITION_SAVE_UI_PASS one metadata save, official reread and no target dispatch",
  );
} finally {
  await browser?.close();
  await app?.close();
  await new Promise((resolve) => target.close(resolve));
  await rm(root, { recursive: true, force: true });
}
