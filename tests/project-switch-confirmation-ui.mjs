import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";
import { projectSwitchPrompt } from "./helpers/project-switch-confirmation-ui.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const evidence = process.env.PROJECT_SWITCH_CONFIRM_EVIDENCE;
const root = await mkdtemp(join(tmpdir(), "project-switch-confirm-"));
const app = await createApp({ root, port: 0 });
let browser;
try {
  const source = await app.store.create("Switch Visual Fixture B");
  source.requests = [
    normalizeRequest({
      id: "fixture",
      name: "未命名接口",
      method: "POST",
      url: "http://127.0.0.1:38982/no-send",
    }),
  ];
  const base = await app.store.save(source);
  const dest = await app.store.create("Switch Visual Fixture A");
  const sourceUri = "/api/projects/" + source.id;
  const targetUri = "/api/projects/" + dest.id;
  const origin = new URL(app.launchUrl).origin;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const capture = async (page, name, narrow = false) => {
    if (!evidence) return;
    await mkdir(evidence, { recursive: true });
    await page.screenshot({
      path: join(evidence, "project-switch-confirm-" + name + ".png"),
      ...(narrow ? {} : { clip: { x: 0, y: 0, width: 1363, height: 580 } }),
      caret: "hide",
    });
  };
  for (const mode of ["discard", "stale", "unknown", "save"]) {
    const page = await browser.newPage({
      viewport: { width: 1363, height: 1023 },
      deviceScaleFactor: 1,
    });
    page.setDefaultTimeout(8000);
    const calls = [],
      blocked = [],
      errors = [];
    let armed = false,
      markHeld,
      release;
    const held = new Promise((resolve) => (markHeld = resolve));
    const gate = new Promise((resolve) => (release = resolve));
    page.on("pageerror", () => errors.push("unexpected page error"));
    await page.addInitScript(
      (id) => sessionStorage.setItem("project", id),
      source.id,
    );
    await page.route("**/*", async (route) => {
      const req = route.request(),
        uri = new URL(req.url());
      if (uri.origin === origin && req.method() === "GET") {
        if (uri.pathname === targetUri) calls.push("target GET");
        return route.continue();
      }
      if (
        uri.origin === origin &&
        req.method() === "PUT" &&
        uri.pathname === sourceUri &&
        armed
      ) {
        armed = false;
        calls.push("source PUT");
        if (mode === "unknown")
          return route.fulfill({
            status: 503,
            json: { error: "synthetic lost receipt" },
          });
        if (mode === "stale") {
          const response = await route.fetch();
          assert.equal(response.ok(), true);
          markHeld();
          await gate;
          return route.fulfill({ response });
        }
        return route.continue();
      }
      blocked.push(req.method());
      return route.abort();
    });
    try {
      await page.goto(app.launchUrl);
      const name = page.locator("#request-name");
      const selected = page.locator("#project-select option[selected]");
      await page
        .locator(`#project-select option[value="${source.id}"][selected]`)
        .waitFor({ state: "attached" });
      await name.fill("未保存的合成接口 " + mode);
      const prompt = projectSwitchPrompt(page);
      const search = page.getByRole("button", {
        name: "搜索项目",
        exact: true,
      });
      const show = async (direct = false) => {
        if (direct) await page.locator("#project-select").selectOption(dest.id);
        else {
          await search.press("Enter");
          await page
            .getByRole("dialog", { name: "搜索项目" })
            .getByRole("button", { name: dest.name, exact: true })
            .press("Enter");
        }
        await prompt.waitFor();
        assert.equal(await selected.getAttribute("value"), source.id);
      };
      const choice = (label) =>
        prompt.getByRole("button", { name: label, exact: true });
      const cancel = choice("取消"),
        discard = choice("不保存"),
        save = choice("保存并继续");
      await show(mode !== "discard");
      if (mode === "discard") {
        const frame = await prompt.boundingBox();
        console.log("PROJECT_SWITCH_PROMPT", JSON.stringify(frame));
        assert.deepEqual(
          [frame.x, frame.y, frame.width, frame.height].map(Math.round),
          [477, 100, 409, 137],
        );
        assert(
          await cancel.evaluate((button) => document.activeElement === button),
        );
        await capture(page, "desktop");
        await page.keyboard.press("Escape");
        await prompt.waitFor({ state: "hidden" });
        assert(
          await search.evaluate((button) => document.activeElement === button),
        );
        assert.deepEqual(calls, []);
        assert.equal(await name.inputValue(), "未保存的合成接口 discard");
        await page.setViewportSize({ width: 430, height: 760 });
        await show(true);
        const narrow = await prompt.boundingBox();
        assert(narrow.x >= 0 && narrow.x + narrow.width <= 430);
        await capture(page, "narrow", true);
        await discard.press("Enter");
        await prompt.waitFor({ state: "hidden" });
        assert.deepEqual(calls, ["target GET"]);
        assert.equal(
          (await app.store.get(source.id)).configRevision,
          base.configRevision,
        );
        assert.equal(await selected.getAttribute("value"), dest.id);
      } else {
        armed = true;
        const firstClick = save.press("Enter");
        if (mode === "stale") {
          await Promise.all([firstClick, held]);
          assert(await save.isDisabled());
          await save.dispatchEvent("click");
          await name.evaluate((input) => {
            input.value = "更新但仍未保存的合成稿";
            input.dispatchEvent(new Event("input", { bubbles: true }));
          });
          release();
        } else await firstClick;
        if (mode === "save") {
          await prompt.waitFor({ state: "hidden" });
          assert.deepEqual(calls, ["source PUT", "target GET"]);
          assert.equal(await selected.getAttribute("value"), dest.id);
          assert.equal(
            (await app.store.get(source.id)).requests[0].name,
            "未保存的合成接口 save",
          );
        } else {
          await prompt
            .getByRole("status")
            .getByText(mode === "stale" ? /未切换项目/ : /保存结果尚未确认/, {
              exact: false,
            })
            .waitFor();
          assert.equal(await selected.getAttribute("value"), source.id);
          assert.deepEqual(calls, ["source PUT"]);
          assert(await save.isDisabled());
          assert(await discard.isDisabled());
          await cancel.press("Enter");
          assert.equal(
            await name.inputValue(),
            mode === "stale"
              ? "更新但仍未保存的合成稿"
              : "未保存的合成接口 unknown",
          );
          assert.equal(
            await page.locator("#saved-state").textContent(),
            "● 未保存",
          );
        }
      }
      assert.deepEqual(blocked, []);
      assert.deepEqual(errors, []);
    } finally {
      release();
      await page.close();
    }
  }
  console.log(
    "PROJECT_SWITCH_CONFIRM_UI_PASS cancel/discard/one-save/held-stale/unknown/focus/desktop-narrow/no-dispatch",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
