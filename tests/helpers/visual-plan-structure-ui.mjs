import {
  holdRealResponse,
  finishHeldRoute,
} from "./execution-write-ownership-ui.mjs";
import assert from "node:assert/strict";
import { createImportOwnershipFixture } from "./project-import-ownership-ui.mjs";
export async function exerciseVisualPlanStructure(page) {
  await createImportOwnershipFixture(page);
  await page.locator('[data-page="apis"]').click();
  await page.locator("#add-request").click();
  await page.locator("#request-name").fill("Structure snapshot source");
  await page
    .locator("#url")
    .fill("http://127.0.0.1:1/structure-must-not-execute");
  const projectId = await page.locator("#project-select").inputValue();
  await Promise.all([
    page.waitForResponse(
      (r) =>
        r.request().method() === "PUT" &&
        new URL(r.url()).pathname === `/api/projects/${projectId}` &&
        r.status() === 200,
    ),
    page.locator("#save").click(),
  ]);
  await page
    .locator("#saved-state")
    .getByText("✓ 已保存", { exact: true })
    .waitFor();
  await page.locator('[data-page="plans"]').click();
  await page.locator("#new-plan").click();
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.locator("#edit-plan").click();
  const original = JSON.parse(await page.locator("#modal-json").inputValue());
  // Define actual multiline request data before opening the separate structure editor.
  original.steps[0].request.body = "\r\nkeep CRLF\rbare CR\n";
  original.steps[0].request.bodyType = "raw";
  original.steps[0].request.futureStructureProof = {
    opaque: ["keep", "unchanged"],
  };
  await page.locator("#modal-json").fill(JSON.stringify(original));
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  let executions = 0;
  const observe = (request) => {
    if (
      request.method() === "POST" &&
      /\/(run|execute|load)$/.test(new URL(request.url()).pathname)
    )
      executions++;
  };
  page.on("request", observe);
  try {
    await page.locator("#edit-plan-structure").click();
    const draft = async () =>
      JSON.parse(await page.locator("[data-structure-json]").inputValue());
    const before = await draft();
    async function operation(action, parent, index) {
      const button = page.locator(
        `[data-structure-action="${action}"][data-parent="${parent}"]${index === undefined ? "" : `[data-index="${index}"]`}`,
      );
      const previous = await page
        .locator("[data-structure-fields]")
        .innerHTML();
      const [response] = await Promise.all([
        page.waitForResponse(
          (r) =>
            new URL(r.url()).pathname ===
              `/api/projects/${projectId}/plans-validate` &&
            r.request().method() === "POST",
        ),
        button.click(),
      ]);
      assert.equal(response.status(), 200);
      await page.waitForFunction(
        (old) =>
          document.querySelector("[data-structure-fields]").innerHTML !== old,
        previous,
      );
      assert.equal(
        await page.locator("[data-structure-error]").isVisible(),
        false,
      );
    }
    await page.locator('[data-new-kind=""]').selectOption("repeat");
    await operation("add", "");
    await page.locator('[data-new-kind="1"]').selectOption("if");
    await operation("add", "1");
    const added = await draft();
    assert.equal(added.steps[1].type, "repeat");
    assert.equal(added.steps[1].steps[1].type, "if");
    assert.equal(
      await page
        .locator(
          '[data-structure-action="remove"][data-parent="1.1"][data-index="0"]',
        )
        .isDisabled(),
      true,
    );
    await operation("up", "1", 1);
    await operation("down", "1", 0);
    await operation("remove", "1", 0);
    const expected = await draft();
    assert.deepEqual(expected.steps[0], before.steps[0]);
    assert.equal(expected.steps[1].steps[0].type, "if");
    const [savedResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === `/api/projects/${projectId}/plans` &&
          r.request().method() === "POST" &&
          r.status() === 200,
      ),
      page.locator("#dialog-save").click(),
    ]);
    const saved = await savedResponse.json();
    await page.locator("#dialog").waitFor({ state: "hidden" });
    assert.deepEqual(saved.steps[0], before.steps[0]);
    assert.deepEqual(
      saved.steps.map((s) => s.id),
      expected.steps.map((s) => s.id),
    );
    assert.equal(saved.steps[1].steps[0].id, expected.steps[1].steps[0].id);
    await page.reload();
    await page.locator('[data-page="plans"]').click();
    await page.locator(`[data-plan="${saved.id}"]`).click();
    await page.locator("#edit-plan-structure").click();
    const reloaded = await draft();
    assert.deepEqual(reloaded.steps, saved.steps);
    // A failed preview does not accept the mutation or put the project in unknown-save state.
    const endpoint = new URL(
      `/api/projects/${projectId}/plans-validate`,
      page.url(),
    ).href;
    const reject = (route) =>
      route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "Structure preview fixture rejection" }),
      });
    await page.route(endpoint, reject);
    try {
      await page
        .locator(
          '[data-structure-action="remove"][data-parent=""][data-index="1"]',
        )
        .click();
      await page
        .locator("[data-structure-error]")
        .getByText("Structure preview fixture rejection", { exact: true })
        .waitFor();
      assert.deepEqual(await draft(), reloaded);
    } finally {
      await page.unroute(endpoint, reject);
    }
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page.locator("#edit-plan-structure").click();
    assert.deepEqual((await draft()).steps, saved.steps);
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    // Closing and reopening keeps #dialog-content connected: old preview must not edit it.
    await page.locator("#edit-plan-structure").click();
    const held = holdRealResponse();
    const hold = (route) => held.handler(route);
    await page.route(endpoint, hold);
    let primary;
    try {
      await page
        .locator(
          '[data-structure-action="remove"][data-parent=""][data-index="1"]',
        )
        .click();
      await held.ready();
      const oldFields = await page
        .locator("[data-structure-fields]")
        .elementHandle();
      await page.locator("#dialog-save").click();
      await page
        .locator("#toast")
        .getByText("结构预检尚未结束，请稍候", { exact: true })
        .waitFor();
      await page.getByRole("button", { name: "关闭", exact: true }).click();
      await page.locator("#edit-plan-structure").click();
      const reopened = await draft();
      await held.release();
      await page.waitForFunction(
        (element) => element.disabled === false,
        oldFields,
      );
      assert.deepEqual(await draft(), reopened);
      assert.deepEqual(reopened.steps, saved.steps);
      assert.equal(
        await page.locator("[data-structure-error]").isVisible(),
        false,
      );
    } catch (e) {
      primary = e;
    } finally {
      await finishHeldRoute(held, () => page.unroute(endpoint, hold), primary);
    }
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    assert.equal(executions, 0);
    console.log("GUI_VISUAL_PLAN_STRUCTURE_PASS");
  } finally {
    page.off("request", observe);
  }
}
