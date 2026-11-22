import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRequest } from "../src/core.mjs";
import { createApp } from "../src/server.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const root = await mkdtemp(join(tmpdir(), "workbench-design-desc-scroll-"));
const app = await createApp({ root, port: 0 });
const origin = new URL(app.launchUrl).origin;
const forbidden = [],
  errors = [];
const content = (name) =>
  [
    "# " + name,
    "",
    ...Array.from(
      { length: 30 },
      (_, i) =>
        `## Fixture ${i + 1}\n\nLocal synthetic description.\n\n- Example line\n`,
    ),
  ].join("\n");
const first = content("First description");
const second = content("Second description");
let browser;
try {
  let owner = await app.store.create("Design description fixture");
  owner.requests = [first, second].map((description, i) =>
    normalizeRequest({
      id: "request-" + i,
      name: "Design fixture " + i,
      url: "",
      description,
    }),
  );
  owner = await app.store.save(owner);
  const baseline = structuredClone(await app.store.get(owner.id));
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
  });
  await page.addInitScript(
    (id) => sessionStorage.setItem("project", id),
    owner.id,
  );
  page.on("pageerror", () => errors.push("unexpected application error"));
  await page.route("**/*", (route) => {
    const req = route.request();
    if (req.method() === "GET" && new URL(req.url()).origin === origin)
      return route.continue();
    forbidden.push(req.method());
    return route.abort();
  });
  await page.goto(app.launchUrl);
  const tab = (mode) => page.locator(`[data-mode="${mode}"]`);
  const request = (n) => page.locator(`[data-request="request-${n}"]`);
  const description = page.locator("#design-description");
  const summary = description.locator("summary");
  const editor = description.getByRole("textbox", {
    name: "接口详细说明",
    exact: true,
  });
  const preview = description.getByRole("region", {
    name: "说明预览",
    exact: true,
  });
  const sync = description.getByRole("checkbox", {
    name: "同步滚动",
    exact: true,
  });
  const top = description.getByRole("button", {
    name: "回到顶部",
    exact: true,
  });
  const foot = description.locator(".design-description-footer");
  const count = description.locator("#design-description-count");
  const focus = (locator) =>
    locator.evaluate((node) => node.ownerDocument.activeElement === node);
  const coordinates = () =>
    page.evaluate(() =>
      ["description", "design-description-preview"].map((id) => {
        const el = document.getElementById(id);
        return { top: el.scrollTop, range: el.scrollHeight - el.clientHeight };
      }),
    );
  const allTop = () =>
    page.waitForFunction(() =>
      ["description", "design-description-preview"].every(
        (id) => document.getElementById(id)?.scrollTop === 0,
      ),
    );
  const paired = () =>
    page.waitForFunction(() => {
      const editor = document.getElementById("description");
      const preview = document.getElementById("design-description-preview");
      if (
        !editor ||
        !preview ||
        editor.scrollTop <= 0 ||
        preview.scrollTop <= 0
      )
        return false;
      return (
        Math.abs(
          editor.scrollTop / (editor.scrollHeight - editor.clientHeight) -
            preview.scrollTop / (preview.scrollHeight - preview.clientHeight),
        ) < 0.003
      );
    });
  const wheel = async (locator, distance) => {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, distance);
  };
  const evidence = process.env.DESIGN_DESCRIPTION_SCROLL_EVIDENCE;
  const capture = async (name) => {
    if (!evidence) return;
    await mkdir(evidence, { recursive: true });
    await foot.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(evidence, "design-description-" + name + ".png"),
      caret: "hide",
      animations: "disabled",
    });
  };

  await tab("design").press("Enter");
  assert.equal(await description.evaluate((node) => node.open), true);
  assert.equal(await sync.isVisible(), true);
  await summary.press("Enter");
  assert.equal(await description.evaluate((node) => node.open), false);
  assert.equal(
    await sync.isVisible(),
    false,
    "closed details hides the footer",
  );
  await summary.press("Enter");
  assert.equal(await sync.isChecked(), true);
  assert.equal(await editor.inputValue(), first);
  assert.match(await count.textContent(), /字数: [0-9]+　行数: [0-9]+/);
  const desktop = await Promise.all([
    editor.boundingBox(),
    preview.boundingBox(),
    foot.boundingBox(),
  ]);
  console.log("DESIGN_DESCRIPTION_DESKTOP", JSON.stringify(desktop));
  assert(Math.abs(desktop[0].y - desktop[1].y) <= 1);
  assert(Math.abs(desktop[0].width - desktop[1].width) <= 1);
  assert.deepEqual(
    desktop.slice(0, 2).map((box) => Math.round(box.height)),
    [100, 100],
  );
  assert((await coordinates()).every(({ range }) => range > 500));
  await capture("top-desktop");

  await wheel(editor, 430);
  await paired();
  await capture("linked-desktop");
  await top.press("Enter");
  await allTop();
  assert.equal(await focus(top), true);
  await wheel(preview, 300);
  await paired();
  await top.press("Enter");
  await allTop();

  await sync.press("Space");
  assert.equal(await sync.isChecked(), false);
  await wheel(preview, 260);
  await page.waitForFunction(
    () => document.getElementById("design-description-preview").scrollTop > 0,
  );
  const detached = await coordinates();
  assert.equal(detached[0].top, 0);
  await capture("unlinked-desktop");
  await summary.press("Enter");
  await summary.press("Enter");
  assert.equal(await sync.isChecked(), false);
  await page.waitForFunction(
    (top) =>
      document.getElementById("design-description-preview").scrollTop === top,
    detached[1].top,
  );
  await tab("debug").press("Enter");
  await tab("design").press("Enter");
  assert.equal(await sync.isChecked(), false);
  await page.waitForFunction(
    (top) =>
      document.getElementById("design-description-preview").scrollTop === top,
    detached[1].top,
  );

  await request(1).click();
  assert.equal(await description.evaluate((node) => node.open), true);
  assert.equal(await sync.isChecked(), true);
  assert.equal(await editor.inputValue(), second);
  await allTop();
  await request(0).click();
  assert.equal(await sync.isChecked(), false);
  assert.equal(await editor.inputValue(), first);
  await page.waitForFunction(
    (top) =>
      document.getElementById("design-description-preview").scrollTop === top,
    detached[1].top,
  );
  await top.press("Enter");
  await allTop();

  await editor.evaluate((node) => {
    node.focus();
    node.setSelectionRange(2, 7);
  });
  await editor.press("Control+b");
  assert.match(await editor.inputValue(), /^# \*\*First\*\*/);
  assert.equal(await preview.locator("h1 strong").textContent(), "First");
  await editor.press("Control+z");
  assert.equal(await editor.inputValue(), first);
  await sync.press("Space");
  assert.equal(await sync.isChecked(), true);

  await page.setViewportSize({ width: 430, height: 830 });
  const narrow = await Promise.all([
    editor.boundingBox(),
    preview.boundingBox(),
    foot.boundingBox(),
  ]);
  console.log("DESIGN_DESCRIPTION_NARROW", JSON.stringify(narrow));
  assert(narrow[1].y >= narrow[0].y + narrow[0].height - 1);
  assert(narrow.every(({ x, width }) => x >= 0 && x + width <= 430));
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  await editor.focus();
  await editor.press("Control+End");
  await paired();
  await top.press("Enter");
  await allTop();
  await capture("narrow");
  assert.deepEqual(await app.store.get(owner.id), baseline);
  assert.deepEqual(
    forbidden,
    [],
    "no sends or project writes from description editing or scrolling",
  );
  assert.deepEqual(errors, []);
  console.log(
    "DESIGN_DESCRIPTION_SCROLL_UI_PASS bidirectional, independent and reopened drafts, formatting undo, no writes or sends",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
