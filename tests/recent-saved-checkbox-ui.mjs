import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const evidence = process.env.RECENT_CHECKBOX_EVIDENCE;
const root = await mkdtemp(join(tmpdir(), "workbench-recent-checkbox-"));
const app = await createApp({ root, port: 0 });
let browser;
try {
  let project = await app.store.create("默认项目");
  project.requests = [
    ["fixture", "Trash Visual Fixture"],
    ["verification", "Verification"],
  ].map(([id, name]) =>
    normalizeRequest({
      id,
      name,
      method: "GET",
      url: "http://127.0.0.1:38982/no-send",
    }),
  );
  project = await app.store.save(project);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({
      viewport: { width: 1363, height: 1023 },
      deviceScaleFactor: 1,
    });
    const pixels = await context.newPage();
    const page = await context.newPage();
    const origin = new URL(app.launchUrl).origin;
    const blocked = [],
      errors = [];
    page.on("pageerror", () => errors.push("unexpected page error"));
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
    await page.addInitScript(
      (choice) => localStorage.setItem("theme", choice),
      theme,
    );
    await page.goto(app.launchUrl);
    await page.waitForFunction(
      (id) =>
        document.querySelector("#project-select option[selected]")?.value ===
        id,
      project.id,
    );
    await page.locator('.rail [data-page="history"]').press("Enter");
    await page
      .getByRole("tab", { name: "已保存版本", exact: true })
      .press("Enter");
    const panel = page.getByRole("tabpanel", { name: "已保存版本" });
    const check = panel.getByRole("checkbox", {
      name: "选择 Trash Visual Fixture",
      exact: true,
    });
    const cancel = panel.getByRole("button", { name: "取消", exact: true });
    await check.waitFor();
    const box = await check.boundingBox();
    assert.deepEqual(
      [box.x, box.y, box.width, box.height].map(Math.round),
      [82, 177, 16, 16],
    );
    const style = () =>
      check.evaluate((element) => {
        const css = getComputedStyle(element);
        return {
          appearance: css.appearance,
          border: css.borderTopColor,
          radius: css.borderTopLeftRadius,
          outline: css.outlineWidth,
          outlineColor: css.outlineColor,
          opacity: css.opacity,
          focus: element.matches(":focus-visible"),
        };
      });
    const sample = async (kind) => {
      await page.mouse.move(960, 360);
      const current = await check.boundingBox();
      const png = await page.screenshot({
        clip: {
          x: Math.round(current.x),
          y: Math.round(current.y),
          width: 16,
          height: 16,
        },
        caret: "hide",
      });
      return pixels
        .evaluate(async (data) => {
          const image = new Image();
          image.src = "data:image/png;base64," + data;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 16;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(image, 0, 0);
          const read = (x, y) =>
            "#" +
            Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3))
              .map((v) => v.toString(16).padStart(2, "0"))
              .join("");
          const inside = [];
          for (let y = 2; y < 14; y++)
            for (let x = 2; x < 14; x++) inside.push(read(x, y));
          return {
            kind: null,
            edge: read(8, 0),
            flat: read(4, 4),
            colors: inside,
          };
        }, png.toString("base64"))
        .then((result) => ({ ...result, kind }));
    };
    const capture = async (kind) => {
      if (!evidence) return;
      await mkdir(evidence, { recursive: true });
      await page.screenshot({
        path: join(evidence, `recent-saved-checkbox-${theme}-${kind}.png`),
        clip: { x: 0, y: 0, width: 1363, height: 350 },
        caret: "hide",
      });
    };
    const expected =
      theme === "dark"
        ? {
            row: "#1e1a12",
            border: "#756956",
            fill: "#bea278",
            tick: "#241d13",
          }
        : {
            row: "#ffffff",
            border: "#978870",
            fill: "#8f7950",
            tick: "#ffffff",
          };
    const idle = await sample("idle");
    console.log("RECENT_SAVED_CHECKBOX", theme, "idle", idle.edge, idle.flat);
    assert.deepEqual([idle.edge, idle.flat], [expected.border, expected.row]);
    assert.equal((await style()).radius, "4px");
    assert.equal((await style()).appearance, "none");
    await capture("idle");
    await check.hover();
    assert.notEqual(
      (await style()).border,
      theme === "dark" ? "rgb(117, 105, 86)" : "rgb(151, 136, 112)",
    );
    await check.press("Space");
    assert(await check.isChecked());
    assert.equal((await style()).focus, true);
    assert.equal((await style()).outline, "2px");
    const checked = await sample("checked");
    console.log(
      "RECENT_SAVED_CHECKBOX",
      theme,
      "checked",
      checked.edge,
      checked.colors.filter((color) => color === expected.fill).length,
    );
    assert.equal(checked.edge, expected.fill);
    assert(
      checked.colors.filter((color) => color === expected.fill).length >= 70,
    );
    assert(
      checked.colors.includes(expected.tick),
      "a real tick must be painted",
    );
    // Mouse click on inert workspace removes the focus ring from the comparison.
    await page.mouse.click(950, 365);
    await capture("checked");
    await cancel.press("Enter");
    assert(!(await check.isChecked()));
    assert(await check.evaluate((input) => input === document.activeElement));
    await page.setViewportSize({ width: 430, height: 760 });
    await page.emulateMedia({ forcedColors: "active" });
    assert.equal((await style()).appearance, "auto");
    await check.press("Space");
    assert(await check.isChecked());
    assert.equal((await style()).focus, true);
    assert.equal((await style()).outline, "2px");
    assert.equal(
      await panel.evaluate((node) => node.scrollWidth - node.clientWidth),
      0,
    );
    await cancel.press("Enter");
    assert(!(await check.isChecked()));
    await page.emulateMedia({ forcedColors: "none" });
    await check.press("Space");
    await panel.getByRole("button", { name: "批量删除" }).press("Enter");
    await page
      .getByRole("dialog", { name: /将所选/ })
      .getByRole("button", { name: "移到回收站", exact: true })
      .press("Enter");
    await page
      .locator("#saved-state")
      .getByText("● 未保存", { exact: true })
      .waitFor();
    assert(await check.isDisabled());
    assert.equal((await style()).opacity, "0.5");
    assert(!(await check.isChecked()));
    assert.deepEqual(blocked, []);
    assert.deepEqual(errors, []);
    const persisted = await app.store.get(project.id);
    assert.equal(persisted.configRevision, project.configRevision);
    assert.equal(persisted.requests.filter((row) => row.deletedAt).length, 0);
    await context.close();
  }
  console.log(
    "RECENT_SAVED_CHECKBOX_UI_PASS native-input/1363/430/light-dark/paint/keyboard/forced-colors/disabled/no-writes",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
