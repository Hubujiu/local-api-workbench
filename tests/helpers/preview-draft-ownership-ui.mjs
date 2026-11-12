import assert from "node:assert/strict";
import { createImportOwnershipFixture } from "./project-import-ownership-ui.mjs";

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("preview fixture response timeout")),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Read through the authenticated browser session, matching the existing
// protocol/restart fixtures. Never return the local token to the test runner.
export async function readPreviewProject(page, url) {
  const result = await page.evaluate(async (url) => {
    if (new URL(url).origin !== location.origin)
      throw Error("Preview snapshot must stay on the application origin");
    const response = await fetch(url, {
      redirect: "error",
      headers: { "x-local-token": sessionStorage.getItem("local-api-token") },
    });
    return {
      status: response.status,
      project: response.ok ? await response.json() : null,
    };
  }, url);
  assert.equal(
    result.status,
    200,
    "authenticated preview snapshot must succeed",
  );
  return result.project;
}

export async function exercisePreviewDraftOwnership(page) {
  await createImportOwnershipFixture(page);
  const other = await page.locator("#project-select").inputValue();
  await createImportOwnershipFixture(page);
  const owner = await page.locator("#project-select").inputValue();
  const endpoint = (id) => new URL(`/api/projects/${id}`, page.url()).href;
  let puts = 0,
    serial = 0;
  const observe = (request) => {
    if (
      request.method() === "PUT" &&
      new URL(request.url()).pathname.startsWith("/api/projects/")
    )
      puts++;
  };
  async function snapshot(id) {
    const project = await readPreviewProject(page, endpoint(id));
    return {
      dictionary: project.parameterDictionary || [],
      codes: project.settings?.statusCodes || [],
    };
  }
  async function select(id) {
    const previousSelect = await page
      .locator("#project-select")
      .elementHandle();
    assert(previousSelect, "project selector must exist before switching");
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
      // A response event precedes JSON consumption. Wait for openProject to
      // replace the old UI, not the still-visible saved marker from its predecessor.
      await page.waitForFunction(
        (element) => !element.isConnected,
        previousSelect,
      );
      assert.equal(await page.locator("#project-select").inputValue(), id);
      await page
        .locator("#saved-state")
        .getByText("✓ 已保存", { exact: true })
        .waitFor();
    } finally {
      await previousSelect.dispose();
    }
  }
  // Observe completion of the actual async onclick, not merely receipt of its
  // HTTP response. Old callbacks can finish after another modal owns the DOM.
  async function submit() {
    const token = ++serial;
    await page.evaluate((token) => {
      const button = document.querySelector("#dialog-save");
      const original = button.onclick;
      window.__previewFixtureDone ||= {};
      button.onclick = async function (event) {
        try {
          return await original.call(this, event);
        } finally {
          window.__previewFixtureDone[token] = true;
        }
      };
    }, token);
    await page.locator("#dialog-save").click();
    return token;
  }
  const consumed = (token) =>
    page.waitForFunction(
      (token) => window.__previewFixtureDone?.[token],
      token,
    );
  const close = async () => {
    await page.keyboard.press("Escape");
    await page.locator("#dialog").waitFor({ state: "hidden" });
  };
  page.on("request", observe);
  try {
    for (const kind of ["dictionary", "error-codes"]) {
      const dictionary = kind === "dictionary";
      const nav = dictionary ? "dictionary" : "docs";
      const button = dictionary
        ? "#import-parameter-dictionary"
        : "#bulk-error-codes";
      const source = dictionary ? "#dictionary-source" : "#error-codes-source";
      const original = await snapshot(owner),
        untouched = await snapshot(other);
      const before = puts;
      const pending = [];
      let nextReady;
      const handler = async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        const item = { release: deferred(), done: deferred() };
        pending.push(item);
        try {
          const response = await route.fetch();
          assert.equal(response.status(), 200);
          nextReady.resolve(item);
          await item.release.promise;
          await route.fulfill({ response });
          item.done.resolve();
        } catch (error) {
          nextReady.reject(error);
          item.done.reject(error);
        }
      };
      const url = endpoint(owner) + `/${kind}-preview`;
      await page.route(url, handler);
      async function open(value) {
        await page.locator(`.rail [data-page="${nav}"]`).click();
        await page.locator(button).click();
        await page.locator(`#dialog ${source}`).fill(value);
      }
      async function start(value) {
        await open(value);
        nextReady = deferred();
        const token = await submit();
        const item = await bounded(nextReady.promise);
        return { ...item, token };
      }
      async function finish(item) {
        item.release.resolve();
        await bounded(item.done.promise);
        await consumed(item.token);
      }
      try {
        // Editing the preview input must invalidate the response without a save.
        let held = await start("old_value: old preview");
        await page
          .locator(`#dialog ${source}`)
          .fill("edited_value: newer input");
        await finish(held);
        assert.equal(
          await page.locator(`#dialog ${source}`).inputValue(),
          "edited_value: newer input",
        );
        await close();
        if (dictionary) {
          held = await start("old_format: old preview");
          await page.locator("#dictionary-format").selectOption("json");
          await finish(held);
          assert.equal(
            await page.locator("#dictionary-format").inputValue(),
            "json",
          );
          await close();
        }
        // Close the pending modal and switch to another real project.
        held = await start("wrong_project: must never persist");
        await close();
        await select(other);
        await finish(held);
        assert.equal(await page.locator("#project-select").inputValue(), other);
        assert.deepEqual(await snapshot(other), untouched);
        await select(owner);

        // Real request-editor input while a preview is pending is preserved.
        held = await start("draft_collision: must not overwrite editing");
        await close();
        await page.locator('.rail [data-page="apis"]').click();
        await page.locator("#add-request").click();
        await page
          .locator("#request-name")
          .fill("Newer unsaved preview fixture draft");
        await finish(held);
        assert.equal(
          await page.locator("#request-name").inputValue(),
          "Newer unsaved preview fixture draft",
        );
        assert.match(await page.locator("#saved-state").innerText(), /未保存/);
        assert.equal(
          puts,
          before,
          "no invalidated preview may save the edited draft",
        );
        let unexpectedDialog;
        const discard = async (dialog) => {
          if (
            dialog.type() === "confirm" &&
            dialog.message() === "当前修改尚未保存，确定切换项目？"
          )
            await dialog.accept();
          else {
            unexpectedDialog = dialog.message();
            await dialog.dismiss();
          }
        };
        page.on("dialog", discard);
        try {
          await select(owner);
        } finally {
          page.off("dialog", discard);
        }
        assert.equal(unexpectedDialog, undefined);
        assert.deepEqual(await snapshot(owner), original);

        // Two genuine preview calls return in reverse order. The newer modal
        // and newer saved project must survive the older callback finishing.
        const old = await start("obsolete_value: obsolete");
        await close();
        const newer = await start("owned_value: saved value");
        await finish(newer);
        if (dictionary) {
          await page
            .locator("#dialog-title")
            .getByText("确认字典导入", { exact: true })
            .waitFor();
          assert.equal(
            await page.locator("[data-import-parameter]").count(),
            1,
          );
          await finish(old);
          assert.match(
            await page.locator("#dialog-content").innerText(),
            /owned_value/,
          );
          assert.doesNotMatch(
            await page.locator("#dialog-content").innerText(),
            /obsolete_value/,
          );
          assert.equal(puts, before, "stale previews must never PUT");
          const token = await submit();
          await consumed(token);
        } else {
          await finish(old);
        }
        await page.locator("#dialog").waitFor({ state: "hidden" });
        assert.equal(
          puts,
          before + 1,
          "only the intentional latest import may PUT",
        );
        await select(owner);
        await page.locator(`.rail [data-page="${nav}"]`).click();
        await page
          .locator(".page table")
          .getByText("owned_value", { exact: true })
          .waitFor();
        const saved = await snapshot(owner);
        if (dictionary) {
          assert(saved.dictionary.some((entry) => entry.key === "owned_value"));
          assert(
            !saved.dictionary.some((entry) =>
              /obsolete|old_|edited_|wrong_/.test(entry.key),
            ),
          );
          assert.deepEqual(saved.codes, original.codes);
        } else {
          assert.deepEqual(
            saved.codes.map(({ code, label }) => ({ code, label })),
            [{ code: "owned_value", label: "saved value" }],
          );
          assert.deepEqual(saved.dictionary, original.dictionary);
        }
        assert.deepEqual(await snapshot(other), untouched);
      } finally {
        for (const item of pending) item.release.resolve();
        await Promise.all(pending.map((item) => bounded(item.done.promise)));
        await page.unroute(url, handler);
      }
    }
    console.log("PREVIEW_DRAFT_OWNERSHIP_UI_PASS");
  } finally {
    page.off("request", observe);
  }
}
