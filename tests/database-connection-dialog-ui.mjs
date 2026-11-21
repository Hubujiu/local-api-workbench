import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createApp } from "../src/server.mjs";
const require = createRequire(import.meta.url);
const {
  chromium,
} = require("/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const app = await createApp({
  root: await mkdtemp("/tmp/workbench-settings-capture-"),
  port: 0,
});
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1188, height: 848 },
  });
  const databaseRequests = [];
  page.on("request", (r) => {
    if (/\/database(?:-connections)?(?:\/|$)/.test(new URL(r.url()).pathname))
      databaseRequests.push([r.method(), r.url()]);
  });
  await page.route("**/*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      url.origin !== new URL(app.launchUrl).origin ||
      (request.method() !== "GET" &&
        /\/database(?:-connections)?(?:\/|$)/.test(url.pathname))
    )
      return route.abort();
    return route.continue();
  });
  await page.goto(app.launchUrl);
  await page.locator('.rail [data-page="settings"]').click();
  await page.locator('[data-page="database"]').click();
  await page.locator("#theme").click();
  await page.locator("#db-new-mysql").click();
  await page
    .locator("#mysql-draft-password")
    .fill("INERT_SECRET_NOT_A_CREDENTIAL");
  assert.equal(
    await page.locator("#mysql-draft-password").getAttribute("type"),
    "password",
  );
  await page
    .locator('#mysql-connection-dialog button[value="cancel"]')
    .last()
    .click();
  assert.equal(await page.locator("#db-password").inputValue(), "");
  await page.locator("#db-new-mysql").click();
  if (process.env.DATABASE_DIALOG_SCREENSHOT)
    await page.screenshot({ path: process.env.DATABASE_DIALOG_SCREENSHOT });
  const bounds = await page.locator("#mysql-connection-dialog").boundingBox();
  await page.locator("#mysql-draft-host").fill("inert.invalid");
  await page.locator("#mysql-draft-tls").check();
  await page.locator("#mysql-draft-ca").fill("INERT CA TEXT");
  await page.locator("#mysql-draft-apply").click();
  assert.equal(await page.locator("#db-type").inputValue(), "mysql");
  assert.equal(await page.locator("#db-host").inputValue(), "inert.invalid");
  assert(await page.locator("#db-tls").isChecked());
  assert.equal(await page.locator("#db-ca").inputValue(), "INERT CA TEXT");
  assert.deepEqual(databaseRequests, []);
  await page.locator("#db-connections").click();
  await page.locator("#db-manager-new").waitFor();
  await page.locator("#db-manager-new").click();
  await page.locator("#mysql-connection-dialog").waitFor();
  await page.keyboard.press("Escape");
  await page.locator("#mysql-connection-dialog").waitFor({ state: "detached" });
  assert.equal(databaseRequests.length, 1);
  assert.equal(databaseRequests[0][0], "GET");
  console.log(
    JSON.stringify({
      bounds,
      databaseRequests: databaseRequests.map((x) => x[0]),
      result: "PASS",
    }),
  );
} finally {
  await browser.close();
  await app.close();
}
