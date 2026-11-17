import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { readFile } from "node:fs/promises";
import { createImportOwnershipFixture } from "./project-import-ownership-ui.mjs";
import { readPreviewProject } from "./preview-draft-ownership-ui.mjs";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("scoped export fixture timeout")),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function exerciseScopedExportUI(page) {
  await createImportOwnershipFixture(page);
  const owner = await page.locator("#project-select").inputValue();
  const endpoint = (id) => new URL(`/api/projects/${id}`, page.url()).href;
  const sourceURL = endpoint(owner);
  const chosenName = "Selected export browser request";
  const hiddenName = "Unselected export browser request";
  for (const [name, suffix] of [
    [chosenName, "chosen?token=selected-fixture-secret"],
    [hiddenName, "hidden?token=unselected-fixture-secret"],
  ]) {
    await page.locator('.rail [data-page="apis"]').click();
    await page.locator("#add-request").click();
    await page.locator("#request-name").fill(name);
    await page.locator("#url").fill(`http://127.0.0.1:1/${suffix}`);
  }
  await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url() === sourceURL &&
        r.request().method() === "PUT" &&
        r.status() === 200,
    ),
    page.locator("#save").click(),
  ]);
  await page
    .locator("#saved-state")
    .getByText("✓ 已保存", { exact: true })
    .waitFor();
  const original = await readPreviewProject(page, sourceURL);
  const chosen = original.requests.find((r) => r.name === chosenName);
  const hidden = original.requests.find((r) => r.name === hiddenName);
  assert(chosen && hidden);
  let downloads = 0,
    sourceWrites = 0,
    exports = 0,
    previews = 0,
    serial = 0;
  const onDownload = () => downloads++;
  const onRequest = (request) => {
    if (request.url() === sourceURL && request.method() === "PUT")
      sourceWrites++;
    if (request.url() === `${sourceURL}/export-selection`) exports++;
    if (request.url() === `${sourceURL}/export-preview`) previews++;
  };
  page.on("download", onDownload);
  page.on("request", onRequest);
  async function close() {
    await page.keyboard.press("Escape");
    await page.locator("#dialog").waitFor({ state: "hidden" });
  }
  async function select(id) {
    const old = await page.locator("#project-select").elementHandle();
    assert(old);
    try {
      await Promise.all([
        page.waitForResponse(
          (r) =>
            r.url() === endpoint(id) &&
            r.request().method() === "GET" &&
            r.status() === 200,
        ),
        page.locator("#project-select").selectOption(id),
      ]);
      await page.waitForFunction((element) => !element.isConnected, old);
      assert.equal(await page.locator("#project-select").inputValue(), id);
    } finally {
      await old.dispose();
    }
  }
  async function submit() {
    const token = ++serial;
    await page.evaluate((token) => {
      const button = document.querySelector("#dialog-save");
      const callback = button.onclick;
      window.__scopedExportDone ||= {};
      button.onclick = async function (event) {
        try {
          return await callback.call(this, event);
        } finally {
          window.__scopedExportDone[token] = true;
        }
      };
    }, token);
    await page.locator("#dialog-save").click();
    return token;
  }
  const consumed = (token) =>
    page.waitForFunction((token) => window.__scopedExportDone?.[token], token);
  const resource = (id) =>
    page.locator(`[data-export-resource][data-kind="api"][data-id="${id}"]`);
  async function open(format = "apipost") {
    await page.locator("#export").click();
    await page.locator("#scoped-export-open").click();
    await page.locator("#scoped-export-format").selectOption(format);
    assert.equal(
      await page.locator("[data-export-resource]:checked").count(),
      0,
      "selection is never silently expanded/defaulted",
    );
    await resource(chosen.id).check();
  }
  async function preview() {
    const token = await submit();
    await consumed(token);
    await page.locator("#scoped-export-accept").waitFor();
    assert.equal(
      await page.locator("#scoped-export-accept").isChecked(),
      false,
    );
    const text = await page.locator("#dialog-content").innerText();
    assert(/依赖/.test(text), "dependency explanation missing");
    assert(/凭据|认证|敏感/.test(text), "sensitivity warning missing");
    assert(
      !/selected-fixture-secret|unselected-fixture-secret/.test(text),
      "preview exposed fixture content",
    );
  }
  async function importDownloaded(text) {
    await createImportOwnershipFixture(page);
    const destination = await page.locator("#project-select").inputValue();
    await page.locator("#import").click();
    await page.locator("#import-text").fill(text);
    const token = await submit();
    await consumed(token);
    await page.locator("#dialog").waitFor({ state: "hidden" });
    await select(destination);
    const saved = await readPreviewProject(page, endpoint(destination));
    assert.equal(saved.requests.length, 1);
    assert.equal(saved.requests[0].name, chosenName);
    let restoredURL;
    try {
      restoredURL = new URL(saved.requests[0].url);
    } catch {
      throw Error("restored request URL is invalid");
    }
    for (const row of saved.requests[0].query || [])
      if (row.enabled !== false)
        restoredURL.searchParams.append(row.key, row.value);
    assert(
      restoredURL.origin + restoredURL.pathname === "http://127.0.0.1:1/chosen",
      "restored request destination differs",
    );
    assert(
      isDeepStrictEqual(restoredURL.searchParams.getAll("token"), [
        "selected-fixture-secret",
      ]),
      "restored selected parameter differs",
    );
    assert(
      !JSON.stringify(saved).includes("unselected-fixture-secret"),
      "unselected fixture content was included",
    );
    assert.equal(saved.history.length, 0);
    assert.equal(saved.runs.length, 0);
    return destination;
  }
  try {
    for (const format of [
      "apipost",
      "apipost-directory",
      "postman-collection-v2.1",
    ]) {
      await select(owner);
      const beforeDownloads = downloads,
        beforeExports = exports;
      await open(format);
      await preview();
      assert.equal(downloads, beforeDownloads);
      if (format === "postman-collection-v2.1")
        assert(
          /环境|全局变量/.test(
            await page.locator("#dialog-content").innerText(),
          ),
          "Postman omission warning missing",
        );
      const denied = await submit();
      await consumed(denied);
      assert.equal(
        exports,
        beforeExports,
        "unchecked dependency consent never requests an export",
      );
      assert.equal(downloads, beforeDownloads);
      await page.locator("#scoped-export-accept").check();
      const downloadPromise = page.waitForEvent("download");
      const token = await submit();
      await consumed(token);
      const download = await downloadPromise;
      const text = await readFile(await download.path(), "utf8");
      let validJSON = false;
      try {
        JSON.parse(text);
        validJSON = true;
      } catch {}
      assert(validJSON, "download is not a valid JSON document");
      assert(
        !text.includes("unselected-fixture-secret"),
        "unselected fixture content was exported",
      );
      assert(
        text.includes("selected-fixture-secret"),
        "selected fixture content was lost",
      );
      assert.equal(exports, beforeExports + 1);
      assert.equal(downloads, beforeDownloads + 1);
      await page.locator("#dialog").waitFor({ state: "hidden" });
      await importDownloaded(text);
      assert(
        isDeepStrictEqual(await readPreviewProject(page, sourceURL), original),
        "source project changed during read-only export",
      );
      assert.equal(sourceWrites, 0, "definition export never saves the source");
      console.log("GUI_SCOPED_EXPORT_FORMAT_PASS", format);
    }

    await select(owner);
    // A real editor draft must remain unsaved; exporting cannot silently persist it.
    await page.locator('.rail [data-page="apis"]').click();
    await page.locator("#search").fill("");
    await page.locator("#tree-type").selectOption("all");
    await page.locator(`[data-request="${hidden.id}"]`).first().click();
    await page.locator("#request-name").fill("Unsaved export fixture draft");
    const beforePreview = previews;
    await open();
    const dirtyAttempt = await submit();
    await consumed(dirtyAttempt);
    assert.equal(previews, beforePreview);
    assert.equal(sourceWrites, 0);
    await close();
    assert.equal(
      await page.locator("#request-name").inputValue(),
      "Unsaved export fixture draft",
    );
    const discard = async (dialog) => {
      assert.equal(dialog.type(), "confirm");
      assert.equal(dialog.message(), "当前修改尚未保存，确定切换项目？");
      await dialog.accept();
    };
    page.on("dialog", discard);
    try {
      await select(owner);
    } finally {
      page.off("dialog", discard);
    }

    // Hold genuine authenticated preview responses, then invalidate their owner/input.
    for (const change of ["selection", "modal", "project"]) {
      await select(owner);
      let held;
      const seen = deferred(),
        release = deferred(),
        done = deferred();
      const handler = async (route) => {
        try {
          const response = await route.fetch();
          assert.equal(response.status(), 200);
          seen.resolve();
          await release.promise;
          await route.fulfill({ response });
          done.resolve();
        } catch (error) {
          seen.reject(error);
          done.reject(error);
        }
      };
      await page.route(`${sourceURL}/export-preview`, handler);
      const before = downloads,
        beforeExport = exports;
      try {
        await open();
        held = await submit();
        await bounded(seen.promise);
        if (change === "selection") {
          await resource(chosen.id).uncheck();
          await resource(hidden.id).check();
        } else {
          await close();
          if (change === "modal") {
            await open();
            await resource(chosen.id).uncheck();
            await resource(hidden.id).check();
          } else {
            await createImportOwnershipFixture(page);
          }
        }
        release.resolve();
        await bounded(done.promise);
        await consumed(held);
        assert.equal(exports, beforeExport);
        assert.equal(downloads, before);
        assert.equal(await page.locator("#scoped-export-accept").count(), 0);
        if (change !== "project") {
          assert.equal(await resource(hidden.id).isChecked(), true);
          await close();
        }
      } finally {
        release.resolve();
        await page.unroute(`${sourceURL}/export-preview`, handler);
      }
    }
    assert.equal(sourceWrites, 0);
    await select(owner);
    await open();
    await preview();
    await page.locator("#scoped-export-accept").check();
    const lostBefore = { downloads, exports };
    const lostReply = async (route) => {
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      await route.abort("failed");
    };
    await page.route(`${sourceURL}/export-selection`, lostReply);
    try {
      const lost = await submit();
      await consumed(lost);
      assert.equal(downloads, lostBefore.downloads);
      assert.equal(exports, lostBefore.exports + 1);
      const repeated = await submit();
      await consumed(repeated);
      assert.equal(
        exports,
        lostBefore.exports + 1,
        "unknown reply cannot repeat the same export attempt",
      );
      assert.equal(downloads, lostBefore.downloads);
      await close();
    } finally {
      await page.unroute(`${sourceURL}/export-selection`, lostReply);
    }
    assert(
      isDeepStrictEqual(await readPreviewProject(page, sourceURL), original),
      "source project changed during read-only export",
    );
    await open();
    await preview();
    const beforeDownloads = downloads;
    // Change only this synthetic fixture's stored config after preview. The UI
    // still holds the old receipt; the real backend must refuse that download.
    const changed = await page.evaluate(async (url) => {
      const headers = {
        "x-local-token": sessionStorage.getItem("local-api-token"),
        "content-type": "application/json",
      };
      const current = await fetch(url, { headers, redirect: "error" });
      if (!current.ok) throw Error("fixture read failed");
      const project = await current.json();
      project.name = "Changed after export preview";
      const response = await fetch(url, {
        method: "PUT",
        headers,
        body: JSON.stringify(project),
        redirect: "error",
      });
      return response.status;
    }, sourceURL);
    assert.equal(changed, 200);
    await page.locator("#scoped-export-accept").check();
    const rejectedResponse = page.waitForResponse(
      (r) =>
        r.url() === `${sourceURL}/export-selection` &&
        r.request().method() === "POST",
    );
    const stale = await submit();
    await consumed(stale);
    assert.equal((await rejectedResponse).status(), 400);
    assert.equal(downloads, beforeDownloads);
    await close();
    await select(owner);
    console.log("GUI_SCOPED_EXPORT_OWNERSHIP_PASS");
  } finally {
    page.off("download", onDownload);
    page.off("request", onRequest);
  }
}
