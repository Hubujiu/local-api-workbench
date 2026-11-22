import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const evidence = process.env.PRODUCT_VERSION_EVIDENCE;
const root = await mkdtemp(join(tmpdir(), "workbench-product-version-ui-"));
const app = await createApp({ root, port: 0 });
let browser;
try {
  let owner = await app.store.create("默认项目");
  owner.requests = [
    normalizeRequest({
      id: "fixture",
      name: "Verification",
      url: "http://127.0.0.1:38982/no-send",
    }),
  ];
  owner = await app.store.save(owner);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const runtime = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ).version;
  for (const desktop of [false, true]) {
    const page = await browser.newPage({
      viewport: { width: 1363, height: 1023 },
      deviceScaleFactor: 1,
    });
    const origin = new URL(app.launchUrl).origin,
      blocked = [],
      errors = [];
    page.on("pageerror", () => errors.push("pageerror"));
    await page.route("**/*", (route) => {
      const request = route.request();
      if (
        new URL(request.url()).origin === origin &&
        request.method() === "GET"
      )
        return route.continue();
      blocked.push(request.method());
      return route.abort();
    });
    if (desktop)
      await page.addInitScript(() => {
        window.desktop = {
          appVersion: () =>
            new Promise((resolve) => {
              window.resolveInstalledVersion = resolve;
            }),
        };
      });
    await page.goto(app.launchUrl);
    await page.waitForFunction(
      (id) =>
        document.querySelector("#project-select option[selected]")?.value ===
        id,
      owner.id,
    );
    const name = page.locator("#request-name");
    await name.fill("Owned unsaved fixture");
    const trigger = page.locator("#appearance-settings");
    const dialog = page.getByRole("dialog", { name: "应用设置", exact: true });
    const view = dialog.getByRole("tab", { name: "版本信息", exact: true });
    const appearance = dialog.getByRole("tab", { name: "外观", exact: true });
    const panel = dialog.getByRole("tabpanel", {
      name: "版本信息",
      exact: true,
    });
    const info = panel.locator("#appearance-version-text");
    const footer = page.locator("#product-version-footer");
    await trigger.press("Enter");
    await appearance.press("End");
    await panel.waitFor();
    assert(await view.evaluate((tab) => tab === document.activeElement));
    assert.equal(await info.textContent(), "本地服务版本：" + runtime);
    assert.equal(await footer.textContent(), "Local API " + runtime);
    assert.equal(await panel.getByRole("button").count(), 0, "no fake updater");
    const geometry = async (locator) => {
      const { x, y, width, height } = await locator.boundingBox();
      return [x, y, width, height].map(Math.round);
    };
    const bounds = {
      frame: await geometry(dialog),
      badge: await geometry(panel.locator(".appearance-version-badge")),
    };
    console.log("PRODUCT_VERSION_GEOMETRY", JSON.stringify(bounds));
    assert.deepEqual(bounds.frame, [242, 212, 880, 600]);
    assert.deepEqual(bounds.badge, [746, 407, 72, 72]);
    if (evidence && !desktop) {
      await mkdir(evidence, { recursive: true });
      await page.screenshot({
        path: join(evidence, "product-version-standalone.png"),
        clip: { x: 224, y: 192, width: 916, height: 643 },
        caret: "hide",
      });
    }
    if (desktop) {
      await page.waitForFunction(
        () => typeof window.resolveInstalledVersion === "function",
      );
      await page.evaluate(() => window.resolveInstalledVersion("2.4.9"));
      await info.getByText("桌面应用版本：2.4.9", { exact: true }).waitFor();
      assert.equal(await footer.textContent(), "Local API 2.4.9");
    }
    await page.setViewportSize({ width: 430, height: 760 });
    const narrow = await geometry(dialog);
    assert(narrow[0] >= 0 && narrow[0] + narrow[2] <= 430);
    await view.press("Home");
    assert(await appearance.evaluate((tab) => tab === document.activeElement));
    assert.equal(
      await page.evaluate(() => localStorage.getItem("theme")),
      null,
    );
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert(await trigger.evaluate((node) => node === document.activeElement));
    assert.equal(await name.inputValue(), "Owned unsaved fixture");
    assert.equal(
      (await app.store.get(owner.id)).configRevision,
      owner.configRevision,
    );
    assert.deepEqual(blocked, []);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    "PRODUCT_VERSION_UI_PASS packaged-bridge/standalone/authenticated-bootstrap/1363+430/draft/zero-writes",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
