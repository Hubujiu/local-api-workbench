import assert from "node:assert/strict";
import http from "node:http";
import { createImportOwnershipFixture } from "./project-import-ownership-ui.mjs";
import {
  commitConcurrentProjectEdit,
  assertStaleProjectRejection,
} from "./project-save-conflict-fixture.mjs";

export async function exerciseProjectSaveConflict(page) {
  let hits = 0;
  const peer = http.createServer((_request, response) => {
    hits++;
    response.end("unexpected fixture business request");
  });
  await new Promise((resolve, reject) => {
    peer.once("error", reject);
    peer.listen(0, "127.0.0.1", resolve);
  });
  try {
    await exerciseConflict(
      page,
      `http://127.0.0.1:${peer.address().port}/never-execute`,
    );
    assert.equal(
      hits,
      0,
      "conflict recovery must not execute the saved request",
    );
    console.log(
      "GUI_PROJECT_SAVE_CONFLICT_BROWSER_PASS",
      "real-owner-CAS/cancel-retains/explicit-discard-GET/explicit-save/zero-peer-hits",
    );
  } finally {
    peer.closeAllConnections();
    await new Promise((resolve, reject) =>
      peer.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
async function exerciseConflict(page, target) {
  await createImportOwnershipFixture(page);
  await page.locator('.rail [data-page="apis"]').click();
  await page.locator("#add-request").click();
  await page.locator("#request-name").fill("Initial conflict fixture");
  await page.locator("#url").fill(target);
  const id = await page.locator("#project-select").inputValue();
  const endpoint = new URL(`/api/projects/${id}`, page.url()).href;
  const responseFor = (method) =>
    page.waitForResponse(
      (r) => r.url() === endpoint && r.request().method() === method,
    );
  const [initialSave] = await Promise.all([
    responseFor("PUT"),
    page.locator("#save").click(),
  ]);
  assert.equal(initialSave.status(), 200);
  await page
    .locator("#saved-state")
    .getByText("✓ 已保存", { exact: true })
    .waitFor();
  const token = await page.evaluate(() =>
    sessionStorage.getItem("local-api-token"),
  );
  assert.ok(token);
  const owner = async (url, method = "GET", data) => {
    const response = await page.request.fetch(url, {
      method,
      headers: { "x-local-token": token },
      ...(data === undefined ? {} : { data }),
    });
    assert.equal(response.status(), 200);
    return response.json();
  };
  const { committed } = await commitConcurrentProjectEdit(owner, endpoint, id);
  const mutations = [],
    gets = [];
  const observe = (r) => {
    if (r.url() === endpoint && r.method() === "GET") gets.push(r);
    if (!["GET", "HEAD"].includes(r.method())) mutations.push(r);
  };
  page.on("request", observe);
  try {
    const draft = "Local draft rejected by CAS";
    await page.locator("#request-name").fill(draft);
    const [rejection] = await Promise.all([
      responseFor("PUT"),
      page.locator("#save").click(),
    ]);
    const receipt = await rejection.json();
    assertStaleProjectRejection(rejection.status(), receipt, id);
    await page
      .locator("#toast")
      .getByText(receipt.error, { exact: true })
      .waitFor();
    await page
      .locator("#saved-state")
      .getByText("● 未保存", { exact: true })
      .waitFor();
    assert.equal(await page.locator("#request-name").inputValue(), draft);
    assert.deepEqual(await owner(endpoint), committed);
    assert.equal(
      mutations.length,
      1,
      "stale save must not automatically retry",
    );
    assert.equal(
      gets.length,
      0,
      "conflict must not automatically reload over the draft",
    );

    async function reload(accept) {
      let seen = 0,
        dialogError,
        completion;
      const confirm = (dialog) => {
        completion = (async () => {
          try {
            assert.equal(dialog.type(), "confirm");
            assert.equal(dialog.message(), "当前修改尚未保存，确定切换项目？");
            seen++;
            if (accept) await dialog.accept();
            else await dialog.dismiss();
          } catch (error) {
            dialogError = error;
            await dialog.dismiss().catch(() => {});
          }
        })();
      };
      page.on("dialog", confirm);
      try {
        const old = await page.locator("#project-select").elementHandle();
        try {
          if (accept) {
            const [response] = await Promise.all([
              responseFor("GET"),
              page.locator("#project-select").selectOption(id),
            ]);
            assert.deepEqual(await response.json(), committed);
            await page.waitForFunction((element) => !element.isConnected, old);
          } else await page.locator("#project-select").selectOption(id);
          assert.ok(completion, "confirmation must actually occur");
          await completion;
          if (dialogError) throw dialogError;
          if (!accept)
            assert.equal(
              await old.evaluate(
                (element) =>
                  element.isConnected &&
                  element === document.querySelector("#project-select"),
              ),
              true,
              "cancel retains original rendered project",
            );
        } finally {
          await old.dispose();
        }
        if (dialogError) throw dialogError;
        assert.equal(seen, 1);
      } finally {
        page.off("dialog", confirm);
      }
    }
    await reload(false);
    assert.equal(await page.locator("#request-name").inputValue(), draft);
    assert.equal(gets.length, 0);
    assert.equal(mutations.length, 1);
    assert.deepEqual(await owner(endpoint), committed);
    await reload(true); // Explicit discard, not automatic draft preservation.
    await page
      .locator("#saved-state")
      .getByText("✓ 已保存", { exact: true })
      .waitFor();
    assert.equal(
      await page.locator("#request-name").inputValue(),
      committed.requests[0].name,
    );
    assert.equal(gets.length, 1);
    assert.equal(mutations.length, 1, "GET reconciliation must not write");
    assert.deepEqual(await owner(endpoint), committed);
    await page
      .locator("#request-name")
      .fill("Explicit edit after conflict reload");
    const [accepted] = await Promise.all([
      responseFor("PUT"),
      page.locator("#save").click(),
    ]);
    assert.equal(accepted.status(), 200);
    const saved = await accepted.json();
    await page
      .locator("#saved-state")
      .getByText("✓ 已保存", { exact: true })
      .waitFor();
    assert.equal(
      saved.name,
      committed.name,
      "retry must keep the concurrent owner's project change",
    );
    assert.equal(saved.requests[0].name, "Explicit edit after conflict reload");
    assert.equal(saved.configRevision, committed.configRevision + 1);
    assert.deepEqual(await owner(endpoint), saved);
    assert.equal(
      mutations.length,
      2,
      "exactly one rejected and one explicitly requested save",
    );
    assert(
      mutations.every((r) => r.url() === endpoint && r.method() === "PUT"),
      "no execution or business request",
    );
  } finally {
    page.off("request", observe);
  }
}
