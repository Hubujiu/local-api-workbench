import assert from "node:assert/strict";
import { createImportOwnershipFixture } from "./project-import-ownership-ui.mjs";
import {
  holdRealResponse,
  finishHeldRoute,
} from "./execution-write-ownership-ui.mjs";
export async function exerciseProjectDraftSave(page) {
  await createImportOwnershipFixture(page);
  await page.locator('.rail [data-page="apis"]').click();
  await page.locator("#add-request").click();
  await page.locator("#request-name").fill("Initial saved request");
  const id = await page.locator("#project-select").inputValue();
  const endpoint = new URL("/api/projects/" + id, page.url()).href;
  const putResponse = () =>
    page.waitForResponse(
      (r) =>
        r.url() === endpoint &&
        r.request().method() === "PUT" &&
        r.status() === 200,
    );
  async function save() {
    await Promise.all([putResponse(), page.locator("#save").click()]);
    await page
      .locator("#saved-state")
      .getByText("✓ 已保存", { exact: true })
      .waitFor();
  }
  await save();
  const held = holdRealResponse();
  const handler = (route) =>
    route.request().method() === "PUT" ? held.handler(route) : route.continue();
  await page.route(endpoint, handler);
  let primary;
  try {
    await page.locator("#request-name").fill("Saved snapshot");
    await page.locator("#save").click();
    await held.ready();
    await page.locator("#request-name").fill("Newer unsaved draft");
    await held.release();
    await page
      .locator("#toast")
      .getByText("已保存本次快照，后续修改仍未保存", { exact: true })
      .waitFor();
    assert.equal(
      await page.locator("#request-name").inputValue(),
      "Newer unsaved draft",
    );
    await page
      .locator("#saved-state")
      .getByText("● 未保存", { exact: true })
      .waitFor();
  } catch (error) {
    primary = error;
  } finally {
    await finishHeldRoute(held, () => page.unroute(endpoint, handler), primary);
  }
  await save();
  let puts = 0,
    committed,
    routeFailure;
  const malformed = async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    puts++;
    try {
      assert.equal(puts, 1, "unknown outcome must not be replayed");
      const upstream = await route.fetch();
      assert.equal(upstream.status(), 200);
      committed = await upstream.json();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id }),
      });
    } catch (error) {
      routeFailure = error;
      await route.abort("failed").catch(() => {});
    }
  };
  await page.route(endpoint, malformed);
  try {
    await page
      .locator("#request-name")
      .fill("Committed before malformed acknowledgement");
    await page.locator("#save").click();
    await page
      .locator("#toast")
      .getByText(/保存结果尚未确认/)
      .waitFor();
    if (routeFailure) throw routeFailure;
    assert.equal(
      committed.requests[0].name,
      "Committed before malformed acknowledgement",
    );
    assert.equal(
      await page.locator("#request-name").inputValue(),
      "Committed before malformed acknowledgement",
    );
    await page
      .locator("#saved-state")
      .getByText("● 未保存", { exact: true })
      .waitFor();
    await page.locator("#save").click();
    await page
      .locator("#toast")
      .getByText(/重新加载原项目核对保存结果/)
      .waitFor();
    assert.equal(puts, 1);
  } finally {
    await page.unroute(endpoint, malformed);
  }
  let dialogError;
  const confirm = async (dialog) => {
    if (
      dialog.type() === "confirm" &&
      dialog.message() === "当前修改尚未保存，确定切换项目？"
    )
      await dialog.accept();
    else {
      dialogError = Error(
        "unexpected reconciliation dialog: " + dialog.message(),
      );
      await dialog.dismiss();
    }
  };
  page.on("dialog", confirm);
  try {
    const old = await page.locator("#project-select").elementHandle();
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url() === endpoint &&
          r.request().method() === "GET" &&
          r.status() === 200,
      ),
      page.locator("#project-select").selectOption(id),
    ]);
    assert.equal(
      (await response.json()).requests[0].name,
      committed.requests[0].name,
    );
    await page.waitForFunction((element) => !element.isConnected, old);
    if (dialogError) throw dialogError;
    await page
      .locator("#saved-state")
      .getByText("✓ 已保存", { exact: true })
      .waitFor();
  } finally {
    page.off("dialog", confirm);
  }
  await page
    .locator("#request-name")
    .fill("Explicit save after reconciliation");
  await save();
  console.log("GUI_PROJECT_DRAFT_SAVE_PASS");
}
