// Actual Chromium + Workbench server. No SQL Server service or invented query success.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { damengPreviewEnabled } from "../src/dameng-process.mjs";
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
const secrets = [secret];
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
  const oracleGate = process.env.LOCALAPI_ORACLE_PREVIEW;
  const damengGate = process.env.LOCALAPI_DAMENG_PREVIEW;
  try {
    process.env.LOCALAPI_ORACLE_PREVIEW = "read-only";
    process.env.LOCALAPI_DAMENG_PREVIEW = "read-only";
    await open();
    await page.selectOption("#db-type", "oracle");
    await page.fill("#db-host", "db.invalid");
    await page.fill("#db-name", "fixture");
    await page.fill("#db-user", "reader");
    await page.fill("#db-server-dn", "CN=db.invalid");
    await page.fill("#db-relations", "APP.ITEMS\nAPP.USERS");
    await page.fill("#db-password", secret);
    await page.click("#db-register");
    const registration = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        r.url().endsWith("/database-connections"),
    );
    await page.getByRole("button", { name: "确认授权", exact: true }).click();
    const receipt = await registration;
    assert.equal(receipt.status(), 200);
    assert.deepEqual((await receipt.json()).relations, [
      "APP.ITEMS",
      "APP.USERS",
    ]);
    await page.locator("#dialog").waitFor({ state: "hidden" });
    assert.equal(await page.inputValue("#db-password"), "");
    await page.fill("#db-password", secret);
    await page.fill("#db-sql", "SELECT id FROM OTHER.ITEMS");
    const denied = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/database"),
    );
    await page.click("#db-query");
    assert.equal((await denied).status(), 400);
    await page.waitForFunction(
      () => !document.querySelector("#db-query").disabled,
    );
    assert.match(await page.textContent("#db-result"), /授权范围/);
    await page.locator('.rail [data-page="settings"]').click();
    await page.locator('[data-settings-anchor="settings-mcp"]').click();
    const projectId = await page.locator("#project-select").inputValue();
    await page.locator("#mcp-config").click();
    for (const name of ["enabled", "write", "execute"])
      await page.locator("#mcp-" + name).check();
    await page.locator(`[data-mcp-project="${projectId}"]`).check();
    await page.locator("#dialog-save").click();
    await page
      .locator("#dialog-title")
      .getByText("MCP 连接配置", { exact: true })
      .waitFor();
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page.locator("#dialog").waitFor({ state: "hidden" });
    const field = (name) => page.locator(`#mcp-db-form [name="${name}"]`);
    await field("type").selectOption("oracle");
    for (const [key, value] of Object.entries({
      name: "Agent Oracle read",
      host: "db.invalid",
      database: "fixture",
      user: "reader",
      password: secret,
      serverDN: "CN=db.invalid",
      relations: "APP.USERS",
    }))
      await field(key).fill(value);
    await field("confirm").check();
    const authorized = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        r.url().endsWith("/mcp-database-connections"),
    );
    await page.locator('#mcp-db-form button[type="submit"]').click();
    const grant = await authorized;
    assert.equal(grant.status(), 200);
    assert.deepEqual((await grant.json()).relations, ["APP.USERS"]);
    assert.equal(await field("password").inputValue(), "");
    const revoke = page.waitForResponse(
      (r) =>
        r.request().method() === "DELETE" &&
        r.url().endsWith("/mcp-database-connections"),
    );
    await page.locator("[data-mcp-db-revoke]").click();
    assert.equal((await revoke).status(), 200);
    if (damengPreviewEnabled()) {
      const fixture = (name) =>
        readFile(new URL("./fixtures/" + name, import.meta.url), "utf8");
      const [ca, clientCert, clientKey] = await Promise.all([
        fixture("localhost.crt"),
        fixture("dameng-client.crt"),
        fixture("localhost.key"),
      ]);
      secrets.push(clientKey.trim());
      const input = {
        host: "localhost",
        user: "reader",
        password: secret,
        relations: "WORKBENCH.READ_FIXTURE",
        ca,
        clientCert,
        clientKey,
      };
      await field("type").selectOption("dameng");
      await field("name").fill("DM8 Agent");
      for (const [key, value] of Object.entries(input))
        await field(key).fill(value);
      await field("confirm").check();
      const agentPost = page.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          r.url().endsWith("/mcp-database-connections"),
      );
      await page.locator('#mcp-db-form button[type="submit"]').click();
      const agentGrant = await agentPost;
      assert.equal(agentGrant.status(), 200);
      assert.deepEqual((await agentGrant.json()).relations, [
        "WORKBENCH.READ_FIXTURE",
      ]);
      assert.doesNotMatch(await agentGrant.text(), /PRIVATE KEY/);
      await page.waitForFunction(
        () =>
          document.querySelector('#mcp-db-form [name="clientKey"]').value ===
          "",
      );
      const revoked = page.waitForResponse(
        (r) =>
          r.request().method() === "DELETE" &&
          r.url().endsWith("/mcp-database-connections"),
      );
      await page.locator("[data-mcp-db-revoke]").click();
      assert.equal((await revoked).status(), 200);
      await open();
      await page.selectOption("#db-type", "dameng");
      for (const [key, value] of Object.entries(input))
        await page.fill(
          "#db-" +
            ({ clientCert: "client-cert", clientKey: "client-key" }[key] ??
              key),
          value,
        );
      await page.click("#db-register");
      await page.fill("#db-connection-name", "DM8 manual");
      assert.equal(await page.inputValue("#db-client-key"), "");
      const ownerPost = page.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          r.url().endsWith("/database-connections"),
      );
      await page.getByRole("button", { name: "确认授权", exact: true }).click();
      const ownerGrant = await ownerPost;
      assert.equal(ownerGrant.status(), 200);
      assert.doesNotMatch(await ownerGrant.text(), /PRIVATE KEY/);
      await page.locator("#dialog").waitFor({ state: "hidden" });
      assert.doesNotMatch(
        await page.evaluate(() =>
          JSON.stringify([{ ...localStorage }, { ...sessionStorage }]),
        ),
        /PRIVATE KEY/,
      );
      console.log("DM8_OWNER_MCP_GUI_PASS temporary mutual TLS credentials");
    }
  } finally {
    if (damengGate === undefined) delete process.env.LOCALAPI_DAMENG_PREVIEW;
    else process.env.LOCALAPI_DAMENG_PREVIEW = damengGate;
    if (oracleGate === undefined) delete process.env.LOCALAPI_ORACLE_PREVIEW;
    else process.env.LOCALAPI_ORACLE_PREVIEW = oracleGate;
  }
  // Scan only this test's disposable project directory, never user data.
  async function scan(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) await scan(f);
      else {
        const bytes = await readFile(f);
        for (const value of secrets)
          assert.ok(!bytes.includes(Buffer.from(value)), f);
      }
    }
  }
  await scan(root);
  assert.deepEqual(errors, []);
  await page.screenshot({
    path: path.join(tmpdir(), "local-api-sqlserver-owner-ui.png"),
  });
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
