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
const home = await mkdtemp(join(tmpdir(), "workbench-script-snippets-"));
let app, browser;
try {
  app = await createApp({ root: home, port: 0 });
  const owner = await app.store.create("Script snippets fixture");
  const url = "http://127.0.0.1:38982/verification";
  const a = normalizeRequest({
    id: "primary-snippet",
    name: "Verification",
    url,
  });
  const b = normalizeRequest({
    id: "other-snippet",
    name: "Independent",
    url,
    beforeScript: "// Independent Pre draft",
    afterScript: "// Independent Post draft",
  });
  owner.requests.push(a, b);
  await app.store.save(owner);
  const baseline = await app.store.get(owner.id);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
    locale: "zh-CN",
  });
  await page.addInitScript((id) => {
    localStorage.setItem("theme", "light");
    sessionStorage.setItem("project", id);
  }, owner.id);
  const origin = new URL(app.launchUrl).origin;
  const writes = [],
    blocked = [],
    errors = [];
  let allowedSave = false;
  page.on("pageerror", (error) => errors.push(error.name));
  await page.route("**/*", (route) => {
    const req = route.request(),
      dest = new URL(req.url());
    if (dest.origin === origin && req.method() === "GET")
      return route.continue();
    if (
      allowedSave &&
      writes.length === 0 &&
      dest.origin === origin &&
      dest.pathname === "/api/projects/" + owner.id &&
      req.method() === "PUT"
    ) {
      writes.push(req.method());
      return route.continue();
    }
    blocked.push(req.method());
    return route.abort();
  });
  const evidence = process.env.HTTP_SCRIPT_SNIPPET_EVIDENCE;
  if (evidence) await mkdir(evidence, { recursive: true });
  const capture = async (state) => {
    if (evidence)
      await page.screenshot({
        path: join(evidence, "http-script-snippets-" + state + ".png"),
        caret: "hide",
        animations: "disabled",
      });
  };
  const tab = (stage) => page.locator(`.param-tabs [data-param="${stage}"]`);
  const pick = (request) =>
    page.locator(`.sidebar [data-request="${request.id}"]`).click();
  const panel = page.getByRole("complementary", {
    name: "常用脚本",
    exact: true,
  });
  const editor = page.locator("#script-code");
  const toggle = panel.getByRole("button", { name: "常用脚本", exact: true });
  const option = (name) => panel.getByRole("button", { name, exact: true });
  const setLocal = option("设置当前请求变量");
  const statusCheck = option("断言响应状态码为 200");
  const active = (locator) =>
    locator.evaluate((el) => el === document.activeElement);
  const postAdvanced = page.locator("#http-post-advanced");
  const showPost = async () => {
    await tab("after").click();
    if (!(await postAdvanced.evaluate((el) => el.open)))
      await postAdvanced.locator(":scope > summary").press("Enter");
  };

  await page.goto(app.launchUrl);
  await pick(a);
  await page.locator('[data-mode="debug"]').click();
  await tab("before").press("Enter");
  await page.locator("#http-pre-add").press("ArrowDown");
  await page
    .locator("#http-pre-menu")
    .getByRole("menuitem", { name: "自定义脚本" })
    .press("Enter");
  assert.equal(await editor.inputValue(), "");
  assert.equal(await active(editor), true);
  assert.equal(await page.locator("#saved-state").textContent(), "✓ 已保存");
  assert.equal(await statusCheck.count(), 0);
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  const bounds = await panel.boundingBox();
  console.log("HTTP_SCRIPT_SNIPPETS_DESKTOP", JSON.stringify(bounds));
  for (const [value, expected] of [
    [bounds.x, 1045],
    [bounds.y, 290],
    [bounds.width, 277],
  ])
    assert(
      Math.abs(value - expected) <= 4,
      JSON.stringify({ value, expected }),
    );
  await capture("pre-desktop");

  const top = 'const greeting = "retained";',
    tail = "// Preserve second line";
  const original = top + "\n" + tail;
  const inserted = 'pm.variables.set("exampleKey", "exampleValue");';
  const afterPre = top + "\n" + inserted + "\n" + tail;
  await editor.fill(original);
  await editor.evaluate(
    (el, token) => el.setSelectionRange(token + 1, token + 4),
    top.indexOf("retained"),
  );
  const inputNode = await editor.elementHandle();
  await setLocal.press("Enter");
  assert.equal(await active(editor), true);
  assert.equal(await editor.inputValue(), afterPre);
  assert.equal(
    await editor.evaluate(
      (node, originalNode) => node === originalNode,
      inputNode,
    ),
    true,
  );
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await editor.press(mod + "+z");
  assert.equal(await editor.inputValue(), original);
  await editor.press(mod + "+Shift+z");
  assert.equal(await editor.inputValue(), afterPre);
  await capture("pre-inserted-after-line");
  await toggle.press("Enter");
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  assert.equal(await setLocal.isVisible(), false);
  assert.equal(await active(toggle), true);
  const folded = await panel.boundingBox();
  assert.equal(folded.width, 40);
  const foldedLayout = await toggle.evaluate((button) => {
    const characters = button.firstElementChild.firstChild;
    const rect = (node) => {
      const { left, right, top, bottom } = node.getBoundingClientRect();
      return { left, right, top, bottom };
    };
    return {
      label: characters.textContent,
      glyphs: [...characters.textContent].map((_, index) => {
        const letter = document.createRange();
        letter.setStart(characters, index);
        letter.setEnd(characters, index + 1);
        return rect(letter);
      }),
      chevron: rect(button.lastElementChild),
      rail: rect(button.closest("aside")),
    };
  });
  console.log(
    "HTTP_SCRIPT_SNIPPETS_FOLDED_GLYPHS",
    JSON.stringify(foldedLayout),
  );
  assert.equal(foldedLayout.label, "常用脚本");
  assert.equal(foldedLayout.glyphs.length, 4);
  const { glyphs, chevron, rail } = foldedLayout;
  for (const [index, glyph] of glyphs.entries()) {
    assert(glyph.right > glyph.left && glyph.bottom > glyph.top);
    assert(glyph.left >= rail.left && glyph.right <= rail.right);
    if (index)
      assert(
        glyph.top >= glyphs[index - 1].bottom - 0.5,
        "Chinese characters must not overlap",
      );
  }
  assert(
    chevron.top >= glyphs.at(-1).bottom - 0.5,
    "Chevron follows the label",
  );
  assert(chevron.bottom <= rail.bottom, "Chevron remains in its rail");
  assert.equal(await editor.inputValue(), afterPre);
  await capture("pre-desktop-folded");

  await showPost();
  assert.equal(await editor.inputValue(), "");
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  await statusCheck.press("Enter");
  const afterPost =
    'pm.test("状态码为 200", () => pm.expect(pm.response.code).to.equal(200));';
  assert.equal(await editor.inputValue(), afterPost);
  await capture("post-desktop");
  const stale = await statusCheck.elementHandle();
  await pick(b);
  await showPost();
  await stale.evaluate((button) => {
    if (button.isConnected)
      throw Error("Expected detached Post snippet button");
    button.click();
  });
  assert.equal(await editor.inputValue(), "// Independent Post draft");
  await tab("before").click();
  assert.equal(await editor.inputValue(), "// Independent Pre draft");
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");

  await pick(a);
  await tab("before").click();
  assert.equal(await editor.inputValue(), afterPre);
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  await toggle.press("Enter");
  await page.setViewportSize({ width: 430, height: 830 });
  const editorBox = await editor.boundingBox();
  const narrow = await panel.boundingBox();
  assert(narrow.y >= editorBox.y + editorBox.height);
  assert(narrow.x >= 0 && narrow.x + narrow.width <= 430);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  await toggle.press("Enter");
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  await toggle.press("Enter");
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  assert.equal(await editor.inputValue(), afterPre);
  await capture("pre-narrow");
  const requestPane = page.locator(".request-panel");
  const lastRecipe = option("读取环境变量");
  const recipeNames = [
    "设置当前请求变量",
    "读取可用变量（优先当前请求）",
    "读取环境变量",
  ];
  const note = panel.getByText("在当前行后插入，不运行或保存。", {
    exact: true,
  });
  await requestPane.evaluate((el) => {
    el.scrollTop = 0;
  });
  const paneBox = await requestPane.boundingBox();
  const hintBox = await note.boundingBox();
  const motion = Math.max(
    0,
    Math.ceil(hintBox.y + hintBox.height - paneBox.y - paneBox.height + 8),
  );
  if (motion) {
    await page.mouse.move(paneBox.x + paneBox.width / 2, paneBox.y + 10);
    await page.mouse.wheel(0, motion);
  }
  const lastHandle = await lastRecipe.elementHandle();
  await page.waitForFunction((button) => {
    const row = button.getBoundingClientRect();
    const pane = button.closest(".request-panel").getBoundingClientRect();
    const note = button.parentElement.lastElementChild.getBoundingClientRect();
    return (
      row.top >= pane.top &&
      note.bottom <= pane.bottom + 1 &&
      button.contains(
        document.elementFromPoint(
          row.left + row.width / 2,
          row.top + row.height / 2,
        ),
      )
    );
  }, lastHandle);
  await capture("pre-narrow-last-recipe-pointer");
  const target = await lastRecipe.boundingBox();
  await page.mouse.click(
    target.x + target.width / 2,
    target.y + target.height / 2,
  );
  assert.match(
    await editor.inputValue(),
    /pm\.environment\.get\("exampleKey"\)/,
  );
  await editor.press(mod + "+z");
  assert.equal(await editor.inputValue(), afterPre);
  await requestPane.evaluate((el) => {
    el.scrollTop = 0;
  });
  await toggle.press("Tab");
  for (const [index, name] of recipeNames.entries()) {
    if (index) await page.keyboard.press("Tab");
    assert.equal(await active(option(name)), true);
  }
  const focused = await lastRecipe.boundingBox();
  const keyboardPane = await requestPane.boundingBox();
  assert(
    focused.y >= keyboardPane.y &&
      focused.y + focused.height <= keyboardPane.y + keyboardPane.height + 1,
  );
  await capture("pre-narrow-last-recipe-keyboard");
  assert.equal(await editor.inputValue(), afterPre);
  assert.deepEqual(await app.store.get(owner.id), baseline);
  assert.deepEqual(writes, []);
  assert.deepEqual(blocked, []);

  await page.setViewportSize({ width: 1363, height: 1023 });
  allowedSave = true;
  await page.locator("#save").click();
  await page
    .locator("#saved-state")
    .getByText("✓ 已保存", { exact: true })
    .waitFor();
  allowedSave = false;
  const saved = await app.store.get(owner.id);
  const request = saved.requests.find((entry) => entry.id === a.id);
  assert.equal(request.beforeScript, afterPre);
  assert.equal(request.afterScript, afterPost);
  assert.deepEqual(
    saved.requests.find((entry) => entry.id === b.id),
    baseline.requests.find((entry) => entry.id === b.id),
  );
  assert.deepEqual(saved.history, baseline.history);
  assert.deepEqual(writes, ["PUT"]);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  console.log(
    "HTTP_SCRIPT_SNIPPETS_UI_PASS after-line insertion/undo, stage and owner isolation, one explicit save, zero dispatch",
  );
} finally {
  try {
    await browser?.close();
  } finally {
    await app?.close();
    await rm(home, { recursive: true, force: true });
  }
}
