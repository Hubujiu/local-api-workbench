import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const evidence = process.env.RECENT_DARK_SHELL_EVIDENCE;
const before = process.env.RECENT_DARK_SHELL_MODE === "before";
const root = await mkdtemp(join(tmpdir(), "workbench-recent-dark-shell-"));
const app = await createApp({ root, port: 0 });
const expected = {
  light: {
    top: "#f3ebdb",
    line: "#e8e5df",
    rail: "#f3ebd8",
    activeRail: "#eee5d3",
    canvas: "#ffffff",
    selectedTab: "#eee5d3",
    idleTab: "#faf6eb",
    date: "#f1ead8",
  },
  dark: before
    ? {
        top: "#17130d",
        line: "#342c1e",
        rail: "#17130d",
        activeRail: "#30291c",
        canvas: "#1e1a12",
        selectedTab: "#30291c",
        idleTab: "#15120d",
        date: "#15120d",
      }
    : {
        top: "#14110c",
        line: "#2d291e",
        rail: "#242017",
        activeRail: "#3b3223",
        canvas: "#1e1a12",
        selectedTab: "#242017",
        idleTab: "#17140f",
        date: "#242017",
      },
};
let browser;
try {
  let owner = await app.store.create("默认项目");
  owner.requests = [
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
  owner = await app.store.save(owner);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  // Decode the rendered Chromium PNG on a blank page, outside the app CSP.
  const pixels = await context.newPage();
  const origin = new URL(app.launchUrl).origin;
  const disallowed = [],
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const request = route.request();
    if (new URL(request.url()).origin === origin && request.method() === "GET")
      return route.continue();
    disallowed.push(request.method());
    return route.abort();
  });
  const theme = page.locator("#theme");
  const recent = page.locator('nav.rail [data-page="history"]');
  const saved = page.getByRole("tab", { name: "已保存版本", exact: true });
  const panel = page.getByRole("tabpanel", { name: "已保存版本", exact: true });
  const search = page.getByRole("searchbox", { name: "按已保存接口名称筛选" });
  const enter = async () => {
    await page.waitForFunction(
      (id) =>
        document.querySelector("#project-select option[selected]")?.value ===
        id,
      owner.id,
    );
    await recent.press("Enter");
    await saved.press("Enter");
    await panel.getByText("Trash Visual Fixture", { exact: true }).waitFor();
    assert.deepEqual(
      (
        await panel.locator("[data-recent-history-name]").allTextContents()
      ).sort(),
      ["Trash Visual Fixture", "Verification"],
    );
  };
  const pickPixels = async (themeName) => {
    // Keep focus rings, glyphs, buttons and structural edges out of each flat ROI.
    await page.mouse.click(930, 525);
    await page.mouse.move(910, 500);
    const coordinates = await page.evaluate(() => {
      const rect = (selector) =>
        document.querySelector(selector).getBoundingClientRect();
      const head = rect("header.top"),
        rail = rect("nav.rail"),
        active = rect("nav.rail [aria-current='page']");
      const selected = rect("#recent-saved-tab"),
        idle = rect("#recent-sent-tab"),
        date = rect("#recent-saved-list summary");
      return {
        top: [320, 20, 11, 5],
        line: [900, Math.round(head.bottom) - 1, 11, 1],
        rail: [Math.round(rail.right) - 14, 650, 7, 7],
        activeRail: [
          Math.round(active.right) - 8,
          Math.round(active.top + active.height / 2) - 3,
          5,
          7,
        ],
        canvas: [950, 690, 17, 9],
        selectedTab: [
          Math.floor(selected.right) - 8,
          Math.round(selected.top + selected.height / 2) - 3,
          5,
          7,
        ],
        idleTab: [
          Math.floor(idle.right) - 8,
          Math.round(idle.top + idle.height / 2) - 3,
          5,
          7,
        ],
        date: [600, Math.round(date.top + date.height / 2) - 3, 7, 7],
      };
    });
    const png = await page.screenshot({
      clip: { x: 0, y: 0, width: 1363, height: 950 },
      caret: "hide",
    });
    const medians = await pixels.evaluate(
      async ({ base64, coordinates }) => {
        const image = new Image();
        image.src = "data:image/png;base64," + base64;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        return Object.fromEntries(
          Object.entries(coordinates).map(([name, roi]) => {
            const rgba = context.getImageData(...roi).data;
            const color = [0, 1, 2]
              .map((offset) => {
                const values = [];
                for (let i = offset; i < rgba.length; i += 4)
                  values.push(rgba[i]);
                return values
                  .sort((a, b) => a - b)
                  [Math.floor(values.length / 2)].toString(16)
                  .padStart(2, "0");
              })
              .join("");
            return [name, "#" + color];
          }),
        );
      },
      { base64: png.toString("base64"), coordinates },
    );
    console.log(
      "RECENT_SHELL_CHROMIUM_PIXELS",
      themeName,
      JSON.stringify(medians),
    );
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await writeFile(
        join(evidence, "recent-workbench-shell-" + themeName + ".png"),
        png,
      );
    }
    assert.deepEqual(medians, expected[themeName]);
  };
  const contrast = (foreground, backdrop) => {
    const luminance = (color) =>
      color
        .match(/\d+/g)
        .slice(0, 3)
        .map(Number)
        .map((channel) => {
          const v = channel / 255;
          return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        })
        .reduce(
          (sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i],
          0,
        );
    const [a, b] = [luminance(foreground), luminance(backdrop)].sort(
      (a, b) => b - a,
    );
    return (a + 0.05) / (b + 0.05);
  };
  const checkKeyboard = async () => {
    const idle = page.getByRole("tab", { name: "历史发送记录", exact: true });
    await saved.press("ArrowLeft");
    const focus = await idle.evaluate((node) => {
      const css = getComputedStyle(node);
      return {
        obtained:
          document.activeElement === node && node.matches(":focus-visible"),
        outline: css.outlineColor,
        width: css.outlineWidth,
        fill: css.backgroundColor,
        foreground: css.color,
      };
    });
    assert(focus.obtained);
    assert.equal(focus.width, "2px");
    assert(contrast(focus.outline, focus.fill) >= 3);
    assert(contrast(focus.foreground, focus.fill) >= 4.5);
    await idle.press("ArrowRight");
    assert(await saved.evaluate((node) => document.activeElement === node));
    await panel.getByText("Verification", { exact: true }).waitFor();
    const ink = await panel
      .locator(".recent-history-day > summary")
      .first()
      .evaluate((node) => {
        const style = getComputedStyle(node);
        return [style.color, style.backgroundColor];
      });
    assert(contrast(...ink) >= 4.5);
  };
  await page.goto(app.launchUrl);
  await enter();
  assert.equal(
    await page
      .locator("body")
      .evaluate((node) => node.classList.contains("dark")),
    false,
  );
  await pickPixels("light");
  await theme.press("Enter");
  assert.equal(
    await page.evaluate(() => localStorage.getItem("theme")),
    "dark",
  );
  await page.reload();
  await enter();
  assert.equal(
    await page
      .locator("body")
      .evaluate((node) => node.classList.contains("dark")),
    true,
  );
  await pickPixels("dark");
  await checkKeyboard();
  await page.setViewportSize({ width: 430, height: 760 });
  await checkKeyboard();
  if (evidence)
    await page.screenshot({
      path: join(evidence, "recent-workbench-shell-dark-narrow.png"),
      caret: "hide",
    });
  await search.fill("verification");
  assert(await panel.getByText("Verification", { exact: true }).isVisible());
  assert(
    await panel.getByText("Trash Visual Fixture", { exact: true }).isHidden(),
  );
  assert.equal(
    await page
      .locator(".recent-workspace")
      .evaluate((node) => node.scrollWidth - node.clientWidth),
    0,
  );
  assert.deepEqual(disallowed, []);
  assert.deepEqual(errors, []);
  assert.equal(
    (await app.store.get(owner.id)).configRevision,
    owner.configRevision,
  );
  console.log(
    "RECENT_DARK_SHELL_UI_PASS light/dark/reload/rgb/contrast/keyboard/430/no-writes",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
