// Actual Chromium + Workbench server. No SQL Server service or invented query success.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({
    chromium,
  } = require("/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"));
}
const root = await mkdtemp(path.join(tmpdir(), "sqlserver-owner-ui-"));
const old = process.env.LOCALAPI_SQLSERVER_PREVIEW;
delete process.env.LOCALAPI_SQLSERVER_PREVIEW;
const app = await createApp({ root, port: 0 });
let browser;
const secret = "INERT_GUI_SQLSERVER_PASSWORD_9210";
try {
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_BUNDLED
      ? undefined
      : process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const open = async () => {
    // A token fragment on the current URL is a same-document navigation.
    await page.goto("about:blank");
    await page.goto(app.launchUrl);
    await page.getByRole("button", { name: "发 送", exact: true }).waitFor();
    await page.locator('.rail [data-page="settings"]').click();
    const response = page.waitForResponse((r) =>
      r.url().endsWith("/api/database-capabilities"),
    );
    await page.locator('[data-page="database"]').click();
    await response;
  };
  await open();
  assert.equal(
    await page.locator('#db-type option[value="sqlserver"]').count(),
    0,
  );
  process.env.LOCALAPI_SQLSERVER_PREVIEW = "read-only";
  await open();
  await page
    .locator('#db-type option[value="sqlserver"]')
    .waitFor({ state: "attached" });
  await page.selectOption("#db-type", "sqlserver");
  assert.equal(await page.locator("#db-tls").isChecked(), true);
  assert.equal(await page.locator("#db-tls").isDisabled(), true);
  assert.equal(await page.locator("#db-write-label").isVisible(), false);
  assert.equal(await page.locator("#db-sqlserver-notice").isVisible(), true);
  assert.equal(await page.locator("#db-auth-source").isVisible(), false);
  assert.equal(await page.locator("#db-path").isVisible(), false);
  await page.fill("#db-host", "fixture.invalid");
  await page.fill("#db-user", "inert");
  await page.fill("#db-password", secret);
  await page.fill("#db-name", "inert");
  await page.fill("#db-port", "");
  const sent = [];
  page.on("request", (r) => {
    if (
      r.method() === "POST" &&
      /\/database(?:-connections)?$/.test(new URL(r.url()).pathname)
    )
      sent.push(r.postDataJSON());
  });
  for (const bad of ["0", " 1433", "1e3", "65536"]) {
    await page.fill("#db-port", bad);
    await page.click("#db-query");
    await page.waitForTimeout(40);
    assert.equal(sent.length, 0);
  }
  await page.fill("#db-port", "");
  await page.click("#db-register");
  assert.equal(await page.inputValue("#db-password"), "");
  await page.fill("#db-connection-name", "SQL Server GUI fixture");
  const registered = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().endsWith("/database-connections"),
  );
  await page.getByRole("button", { name: "确认授权", exact: true }).click();
  assert.equal((await registered).status(), 200);
  await page.locator("#dialog").waitFor({ state: "hidden" });
  assert.deepEqual(
    Object.keys(sent[0]).sort(),
    ["database", "host", "name", "password", "ssl", "type", "user"].sort(),
  );
  assert.equal(sent[0].type, "sqlserver");
  assert.equal(sent[0].ssl, true);
  assert.equal(sent[0].password, secret);
  // Real server rejects invalid SQL before any network connection.
  await page.fill("#db-password", secret);
  await page.fill("#db-sql", "DELETE FROM dbo.items");
  const rejected = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/database"),
  );
  await page.click("#db-query");
  assert.equal((await rejected).status(), 400);
  await page.waitForFunction(
    () => !document.querySelector("#db-query").disabled,
  );
  assert.equal(await page.inputValue("#db-password"), "");
  assert.equal(await page.locator("#db-tls").isDisabled(), true);
  assert.deepEqual(
    Object.keys(sent[1]).sort(),
    [
      "database",
      "host",
      "parameters",
      "password",
      "sql",
      "ssl",
      "type",
      "user",
    ].sort(),
  );
  assert.ok(!(await page.textContent("#db-result")).includes(secret));
  assert.ok(
    !JSON.stringify(
      await page.evaluate(() => ({
        local: { ...localStorage },
        session: { ...sessionStorage },
      })),
    ).includes(secret),
  );
  // Stale UI capability cannot override the host gate.
  delete process.env.LOCALAPI_SQLSERVER_PREVIEW;
  await page.fill("#db-password", secret);
  await page.fill("#db-sql", "SELECT id FROM dbo.items");
  const disabled = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/database"),
  );
  await page.click("#db-query");
  assert.equal((await disabled).status(), 400);
  await open();
  assert.equal(
    await page.locator('#db-type option[value="sqlserver"]').count(),
    0,
  );
  // Failed capability fetch remains closed even when the host preview is enabled.
  process.env.LOCALAPI_SQLSERVER_PREVIEW = "read-only";
  await page.route("**/api/database-capabilities", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"error":"inert unavailable"}',
    }),
  );
  await open();
  assert.equal(
    await page.locator('#db-type option[value="sqlserver"]').count(),
    0,
  );
  await page.unroute("**/api/database-capabilities");
  // Scan only this test's disposable project directory, never user data.
  async function scan(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) await scan(f);
      else assert.ok(!(await readFile(f)).includes(Buffer.from(secret)), f);
    }
  }
  await scan(root);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(tmpdir(), "local-api-sqlserver-owner-ui.png") });
  console.log(
    "SQLSERVER_OWNER_GUI_PASS real-browser/server; no real SQL Server acceptance",
  );
} finally {
  if (old === undefined) delete process.env.LOCALAPI_SQLSERVER_PREVIEW;
  else process.env.LOCALAPI_SQLSERVER_PREVIEW = old;
  await browser?.close();
  app.server.closeAllConnections();
  await new Promise((r) => app.server.close(r));
  await rm(root, { recursive: true, force: true });
}
