import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";
import { openProjectCreateUI } from "./helpers/open-project-create-ui.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const root = await mkdtemp(join(tmpdir(), "project-create-settlement-"));
const app = await createApp({ root, port: 0 });
let browser;
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { resolve, promise };
};
const bounded = async (promise) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Creation fixture response timeout")),
          9000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
try {
  const origin = new URL(app.launchUrl).origin;
  const source = await app.store.create("合成原项目");
  source.requests.push(
    normalizeRequest({
      id: "own-request",
      name: "原项目接口",
      method: "GET",
      url: "http://127.0.0.1:1/never-send",
    }),
  );
  await app.store.save(source);
  const original = await app.store.get(source.id);
  const peer = await app.store.create("合成另一项目");
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });

  for (const mode of ["post", "registry", "target", "edit", "unknown"]) {
    const createdName = "Creation " + mode;
    const register = "/api/projects";
    const page = await browser.newPage({
      viewport: { width: 1363, height: 1023 },
      deviceScaleFactor: 1,
      locale: "zh-CN",
    });
    page.setDefaultTimeout(8000);
    const holdReady = deferred(),
      release = deferred();
    const calls = [],
      blocked = [],
      errors = [];
    let submitted = false,
      allowCreate = false,
      createdId,
      targetHeld = false;
    const onRegistry = () =>
      calls.filter((call) => call === "registry GET").length;
    const recordedIds = async () =>
      (await app.store.list())
        .filter((item) => item.name === createdName)
        .map(({ id }) => id);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((sourceId) => {
      sessionStorage.setItem("project", sourceId);
      window.__creationReads = [];
      const fetchNative = window.fetch;
      window.fetch = async (url, init) => {
        const response = await fetchNative(url, init);
        const json = response.json.bind(response);
        response.json = async () => {
          const value = await json();
          window.__creationReads.push([url, init?.method || "GET"]);
          return value;
        };
        return response;
      };
    }, source.id);
    await page.route("**/*", async (route) => {
      const request = route.request(),
        target = new URL(request.url());
      if (target.origin === origin && request.method() === "GET") {
        if (submitted && target.pathname === register) {
          calls.push("registry GET");
          if (["registry", "edit"].includes(mode) && onRegistry() === 1) {
            const response = await route.fetch();
            assert.equal(response.status(), 200);
            holdReady.resolve();
            await release.promise;
            return route.fulfill({ response });
          }
        }
        if (createdId && target.pathname === register + "/" + createdId) {
          calls.push("created GET");
          if (mode === "target" && !targetHeld) {
            targetHeld = true;
            const response = await route.fetch();
            assert.equal(response.status(), 200);
            holdReady.resolve();
            await release.promise;
            return route.fulfill({ response });
          }
        }
        return route.continue();
      }
      if (
        target.origin === origin &&
        target.pathname === register &&
        request.method() === "POST" &&
        allowCreate
      ) {
        allowCreate = false;
        submitted = true;
        calls.push("create POST");
        assert.equal(request.postDataJSON().name, createdName);
        const response = await route.fetch();
        assert.equal(response.status(), 201);
        createdId = (await response.json()).id;
        if (mode === "post") {
          holdReady.resolve();
          await release.promise;
        }
        if (mode === "unknown")
          return route.fulfill({
            status: 503,
            json: { error: "synthetic missing create receipt" },
          });
        return route.fulfill({ response });
      }
      blocked.push([request.method(), target.pathname]);
      return route.abort();
    });
    try {
      await page.goto(app.launchUrl);
      const control = page.locator("#project-select");
      const owner = () =>
        control.locator("option[selected]").getAttribute("value");
      const dialog = page.getByRole("dialog", {
        name: "新建项目",
        exact: true,
      });
      const field = dialog.getByRole("textbox", {
        name: "项目名称",
        exact: true,
      });
      const submit = dialog.getByRole("button", { name: "确定", exact: true });
      const status = dialog.getByRole("status");
      const review = dialog.getByRole("button", {
        name: "重新读取项目列表",
        exact: true,
      });
      await openProjectCreateUI(page);
      await field.fill("Never submitted");
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      assert.deepEqual(calls, []);
      await openProjectCreateUI(page);
      await field.fill(createdName);
      allowCreate = true;
      await submit.press("Enter");
      if (mode === "unknown") {
        await status.getByText(/创建结果尚未确认/).waitFor();
        assert.deepEqual(calls, ["create POST"]);
        assert.equal(await owner(), source.id);
        assert.equal(await submit.isDisabled(), true);
        await submit.dispatchEvent("click");
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
        await openProjectCreateUI(page);
        await status.getByText(/创建结果尚未确认/).waitFor();
      } else {
        await bounded(holdReady.promise);
        assert.equal(await submit.isDisabled(), true);
        await dialog
          .getByRole("button", { name: "返回工作区", exact: true })
          .waitFor();
        await submit.dispatchEvent("click");
        if (mode === "edit") {
          // Model a pending same-owner draft update without closing/replacing the form.
          await page.locator("#request-name").evaluate((input) => {
            input.value = "同项目较新的合成草稿";
            input.dispatchEvent(new Event("input", { bubbles: true }));
          });
          release.resolve();
          await status.getByText(/项目已创建，但未打开/).waitFor();
          assert.equal(await owner(), source.id);
          assert.equal(
            await page.locator("#request-name").inputValue(),
            "同项目较新的合成草稿",
          );
          assert.equal(
            await control.locator(`option[value="${createdId}"]`).count(),
            0,
          );
          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "hidden" });
          await openProjectCreateUI(page);
          await status.getByText(/项目已创建，但未打开/).waitFor();
        } else {
          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "hidden" });

          // Move to another real workspace before returning the old receipt.
          await control.selectOption(peer.id);
          await control
            .locator(`option[value="${peer.id}"][selected]`)
            .waitFor({ state: "attached" });
          release.resolve();
          const lateUrl =
            mode === "target" ? register + "/" + createdId : register;
          const lateMethod = mode === "post" ? "POST" : "GET";
          const expectedReadCount = mode === "registry" ? 2 : 1;
          await page.waitForFunction(
            ({ url, method, count }) =>
              window.__creationReads.filter(
                ([path, verb]) => path === url && verb === method,
              ).length >= count,
            { url: lateUrl, method: lateMethod, count: expectedReadCount },
          );
          assert.equal(await owner(), peer.id);
          assert.equal(
            await control.locator(`option[value="${createdId}"]`).count(),
            0,
          );
          await openProjectCreateUI(page);
          await status.getByText(/项目已创建，但未打开/).waitFor();
        }
      }

      const prior =
        mode === "post" || mode === "unknown"
          ? ["create POST"]
          : ["registry", "edit"].includes(mode)
            ? ["create POST", "registry GET"]
            : ["create POST", "registry GET", "created GET"];
      assert.deepEqual(calls, prior);
      assert.deepEqual(await recordedIds(), [createdId]);
      await review.press("Enter");
      await status.getByText(/已重新读取项目列表/).waitFor();
      assert.deepEqual(calls, [...prior, "registry GET"]);
      assert.equal(
        await control.locator(`option[value="${createdId}"]`).count(),
        1,
      );
      assert.equal(
        await owner(),
        ["unknown", "edit"].includes(mode) ? source.id : peer.id,
      );
      assert.equal(await submit.isDisabled(), true);
      await dialog
        .getByRole("button", { name: "已核对，开始新的创建", exact: true })
        .press("Enter");
      assert.equal(await field.inputValue(), "");
      assert.equal(await submit.isEnabled(), true);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      assert.deepEqual(calls, [...prior, "registry GET"]);
      if (mode === "edit") {
        assert.equal(
          await page.locator("#request-name").inputValue(),
          "同项目较新的合成草稿",
        );
        assert.equal(await owner(), source.id);
      } else {
        await control.selectOption(createdId);
        await control
          .locator(`option[value="${createdId}"][selected]`)
          .waitFor({ state: "attached" });
        assert.deepEqual(calls, [...prior, "registry GET", "created GET"]);
      }
      assert.deepEqual(await recordedIds(), [createdId]);
      assert.deepEqual(await app.store.get(source.id), original);
      assert.deepEqual(blocked, []);
      assert.deepEqual(errors, []);
      console.log(
        "PROJECT_CREATE_SETTLEMENT_UI_PASS",
        mode,
        JSON.stringify(calls),
      );
    } finally {
      release.resolve();
      await page.close();
    }
  }
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
