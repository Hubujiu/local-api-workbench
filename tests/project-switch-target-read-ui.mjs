import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";
import { projectSwitchPrompt } from "./helpers/project-switch-confirmation-ui.mjs";
import { assertStaleProjectRejection } from "./helpers/project-save-conflict-fixture.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const root = await mkdtemp(join(tmpdir(), "project-switch-target-read-"));
const app = await createApp({ root, port: 0 });
let browser;
try {
  const origin = new URL(app.launchUrl).origin;
  const seed = async (name) => {
    const fixture = await app.store.create(name);
    fixture.requests = [
      normalizeRequest({
        id: "disposable-fixture",
        name: "合成接口",
        method: "GET",
        url: "http://127.0.0.1:1/never-dispatch",
      }),
    ];
    return app.store.save(fixture);
  };
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  for (const mode of ["discard-escape", "save-escape", "timeout", "rejected"]) {
    const source = await seed("Source " + mode);
    const dest = await seed("Destination " + mode);
    const sourceUri = "/api/projects/" + source.id;
    const destUri = "/api/projects/" + dest.id;
    const page = await browser.newPage({
      viewport: { width: 1363, height: 1023 },
      deviceScaleFactor: 1,
    });
    const calls = [],
      savedReads = [],
      blocked = [],
      errors = [];
    let armed = false,
      readReady,
      release,
      putReady,
      releasePut;
    const readHeld = new Promise((resolve) => {
      readReady = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const putHeld = new Promise((resolve) => {
      putReady = resolve;
    });
    const putGate = new Promise((resolve) => {
      releasePut = resolve;
    });
    page.setDefaultTimeout(8000);
    page.on("pageerror", (error) => errors.push(error.message));
    // Deliberately deliver target-only late replies even after the UI aborts.
    // This proves both the actual signal and the independent adoption fence.
    await page.addInitScript(
      ({ id, destUri }) => {
        sessionStorage.setItem("project", id);
        const fetchNative = window.fetch;
        window.fetch = async (url, init) => {
          if (url !== destUri || init?.method !== "GET")
            return fetchNative(url, init);
          window.__targetReadFixture = {
            hadSignal: Boolean(init.signal),
            aborted: false,
            consumed: false,
          };
          const state = window.__targetReadFixture;
          init.signal?.addEventListener("abort", () => {
            state.aborted = true;
          });
          const response = await fetchNative(url, {
            ...init,
            signal: undefined,
          });
          const json = response.json.bind(response);
          response.json = async () => {
            const value = await json();
            state.consumed = true;
            return value;
          };
          return response;
        };
      },
      { id: source.id, destUri },
    );
    await page.route("**/*", async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      if (url.origin === origin && req.method() === "GET") {
        if (url.pathname === sourceUri + "/recent-saved-definitions")
          savedReads.push(url.pathname);
        if (url.pathname === destUri) {
          calls.push("target GET");
          const response = await route.fetch();
          assert.equal(response.status(), 200);
          readReady();
          await gate;
          return route.fulfill({ response });
        }
        return route.continue();
      }
      if (
        url.origin === origin &&
        req.method() === "PUT" &&
        url.pathname === sourceUri &&
        armed
      ) {
        armed = false;
        calls.push("source PUT");
        if (mode === "save-escape") {
          const response = await route.fetch();
          assert.equal(response.status(), 200);
          putReady();
          await putGate;
          return route.fulfill({ response });
        }
        return route.continue();
      }
      blocked.push([req.method(), url.pathname]);
      return route.abort();
    });
    try {
      if (mode === "timeout") await page.clock.install();
      await page.goto(app.launchUrl);
      const name = page.locator("#request-name");
      const draft = "未保存草稿 " + mode;
      await name.fill(draft);
      let expectedSource = source;
      if (mode === "rejected") {
        const concurrent = await app.store.get(source.id);
        concurrent.requests[0].description = "另一个本机窗口提交的合成更改";
        expectedSource = await app.store.save(concurrent);
      }
      const recent = mode === "discard-escape";
      const savedTab = page.locator("#recent-saved-tab");
      const recentQuery = page.locator("#recent-history-query");
      if (recent) {
        await page.locator('.rail [data-page="history"]').click();
        await savedTab.click();
        await page
          .locator("#recent-saved-list")
          .getByText("合成接口", { exact: true })
          .waitFor();
        await recentQuery.fill("合成");
        assert.equal(savedReads.length, 1);
      }
      const direct = page.locator("#project-select");
      await direct.selectOption(dest.id);
      const prompt = projectSwitchPrompt(page);
      await prompt.waitFor();
      const cancel = prompt.getByRole("button", { name: "取消", exact: true });
      const save = prompt.getByRole("button", {
        name: "保存并继续",
        exact: true,
      });
      const discard = prompt.getByRole("button", {
        name: "不保存",
        exact: true,
      });
      const owner = () =>
        direct.locator("option[selected]").getAttribute("value");
      const status = prompt.getByRole("status");
      if (mode === "rejected") {
        armed = true;
        const [reply] = await Promise.all([
          page.waitForResponse(
            (res) =>
              new URL(res.url()).pathname === sourceUri &&
              res.request().method() === "PUT",
          ),
          save.press("Enter"),
        ]);
        const receipt = await reply.json();
        // The real owner PUT reports stale CAS as HTTP 400 with a typed
        // not-committed receipt. Prove this is the stale snapshot, not another 400.
        assertStaleProjectRejection(reply.status(), receipt, source.id);
        assert.equal(
          receipt.error,
          "项目文件已被其他窗口或 Git 修改，请重新加载后再保存",
        );
        const sentSnapshot = reply.request().postDataJSON();
        assert.equal(sentSnapshot.configRevision, source.configRevision);
        assert.equal(sentSnapshot.requests[0].name, draft);
        assert.equal(expectedSource.configRevision, source.configRevision + 1);
        await status.getByText(receipt.error, { exact: true }).waitFor();
        assert.deepEqual(calls, ["source PUT"]);
        assert.equal(await owner(), source.id);
        assert.equal(await discard.isDisabled(), true);
        assert.equal(await save.isDisabled(), true);
        await cancel.press("Enter");
        assert.equal(await name.inputValue(), draft);
        assert.match(await page.locator("#saved-state").innerText(), /未保存/);
        assert.deepEqual(await app.store.get(source.id), expectedSource);
      } else {
        if (mode === "save-escape") {
          armed = true;
          await save.press("Enter");
          await putHeld;
          await page.keyboard.press("Escape");
          assert.equal(
            await prompt.isVisible(),
            true,
            "in-flight source PUT cannot be canceled",
          );
          assert.equal(await cancel.isDisabled(), true);
          assert.deepEqual(calls, ["source PUT"]);
          releasePut();
        } else {
          await discard.press("Enter");
        }
        await readHeld;
        await status.getByText(/正在打开目标项目/).waitFor();
        assert.equal(await cancel.isEnabled(), true);
        assert.deepEqual(
          await page.evaluate(() => window.__targetReadFixture),
          {
            hadSignal: true,
            aborted: false,
            consumed: false,
          },
        );
        const expectedCalls =
          mode === "save-escape"
            ? ["source PUT", "target GET"]
            : ["target GET"];
        if (mode === "save-escape") {
          expectedSource = await app.store.get(source.id);
          assert.equal(expectedSource.requests[0].name, draft);
        }
        await page.keyboard.press("Control+s");
        await page.keyboard.press("Control+Enter");
        assert.deepEqual(calls, expectedCalls);
        if (mode === "timeout") {
          await page.clock.fastForward(15_100);
          await status
            .getByText("读取目标项目超时，未切换项目。", { exact: true })
            .waitFor();
          assert.equal(await save.isDisabled(), true);
          assert.equal(await discard.isDisabled(), true);
          await cancel.press("Enter");
        } else {
          await page.keyboard.press("Escape");
        }
        await prompt.waitFor({ state: "hidden" });
        assert.equal(
          await direct.evaluate((el) => el === document.activeElement),
          true,
        );
        assert.equal(await owner(), source.id);
        if (recent) {
          assert.equal(await savedTab.getAttribute("aria-selected"), "true");
          assert.equal(await recentQuery.inputValue(), "合成");
          await Promise.all([
            page.waitForResponse(
              (res) =>
                new URL(res.url()).pathname ===
                sourceUri + "/recent-saved-definitions",
            ),
            page.locator("#recent-saved-reload").click(),
          ]);
          await page
            .locator("#recent-saved-list")
            .getByText("合成接口", { exact: true })
            .waitFor();
          assert.equal(
            savedReads.length,
            2,
            "retained source handlers remain live",
          );
          await page.locator('.rail [data-page="apis"]').click();
        }
        assert.equal(await name.inputValue(), draft);
        assert.equal(
          await page.evaluate(() => window.__targetReadFixture.aborted),
          true,
        );
        assert.deepEqual(
          calls,
          expectedCalls,
          "leaving the modal starts no writes and no retry",
        );
        release();
        await page.waitForFunction(() => window.__targetReadFixture.consumed);
        assert.equal(
          await owner(),
          source.id,
          "late destination receipt must not replace the source",
        );
        assert.deepEqual(await app.store.get(source.id), expectedSource);
      }
      assert.deepEqual(await app.store.get(dest.id), dest);
      assert.deepEqual(blocked, []);
      assert.deepEqual(errors, []);
      console.log(
        "PROJECT_SWITCH_TARGET_READ_PASS",
        mode,
        JSON.stringify(calls),
      );
    } finally {
      release();
      releasePut();
      await page.close();
    }
  }
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
