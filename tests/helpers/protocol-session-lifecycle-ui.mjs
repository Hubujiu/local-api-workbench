import assert from "node:assert/strict";
import {
  holdRealResponse,
  finishHeldRoute,
} from "./execution-write-ownership-ui.mjs";
export async function exerciseProtocolSessionLifecycle(page) {
  let starts = 0,
    mode = "normal",
    intentURL = "",
    routeFailure,
    primary;
  const pattern = /\/api\/protocol-session-intents\/[0-9a-f-]+$/;
  const held = holdRealResponse();
  const handler = async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    starts++;
    intentURL = route.request().url();
    if (mode === "held") return held.handler(route);
    if (mode === "drop") {
      try {
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        await route.abort("failed");
      } catch (error) {
        routeFailure = error;
        await route.abort("failed").catch(() => {});
      }
      return;
    }
    return route.continue();
  };
  await page.route(pattern, handler);
  try {
    await page.locator("#session-connect").click();
    await page
      .locator("#session-events")
      .getByText("ui-stream-fixture", { exact: false })
      .waitFor();
    await page.locator("#session-stop").click();
    await page.getByText("closed", { exact: true }).waitFor();
    assert.equal(starts, 1);
    mode = "drop";
    await page.locator("#session-connect").click();
    await page
      .locator("#session-status")
      .getByText(/连接结果待核对/)
      .waitFor();
    if (routeFailure) throw routeFailure;
    await page.locator("#session-connect").dispatchEvent("click");
    assert.equal(starts, 2, "unknown start must not automatically repeat");
    const unknownIntent = intentURL;
    await page.reload();
    await page.locator("[data-protocol-id]").first().click();
    await page
      .locator("#session-events")
      .getByText("ui-stream-fixture", { exact: false })
      .waitFor();
    assert.equal(starts, 2, "reload must restore by GET only");
    const restored = await page.evaluate(async (url) => {
      const r = await fetch(url, {
        headers: { "x-local-token": sessionStorage.getItem("local-api-token") },
      });
      return r.json();
    }, unknownIntent);
    assert.equal(restored.phase, "started");
    await page.locator("#session-stop").click();
    await page.getByText("closed", { exact: true }).waitFor();
    // Restore the explicit endpoint form after reload; no transport action occurs here.
    const definition = await page.evaluate(async (url) => {
      const r = await fetch(url, {
        headers: { "x-local-token": sessionStorage.getItem("local-api-token") },
      });
      return r.json();
    }, unknownIntent);
    assert.equal(definition.phase, "cancelled");
    mode = "held";
    // Re-select the saved SSE definition used by this smoke scenario.
    await page.locator("[data-protocol-id]").first().click();
    await page.locator("#session-connect").click();
    await held.ready();
    const pendingIntent = intentURL;
    await page.locator("#session-connect").dispatchEvent("click");
    assert.equal(starts, 3);
    await page.locator("#session-stop").click();
    await page
      .locator("#session-status")
      .getByText(/closed|已关闭/)
      .waitFor();
    const stopped = await page.evaluate(async (url) => {
      const r = await fetch(url, {
        headers: { "x-local-token": sessionStorage.getItem("local-api-token") },
      });
      return r.json();
    }, pendingIntent);
    assert.equal(stopped.phase, "cancelled");
    assert.ok(["closed", "error"].includes(stopped.session.state));
    await held.release();
    await page.reload();
    await page.locator("[data-protocol-id]").first().click();
    await page
      .locator("#session-status")
      .getByText(/closed|已关闭/)
      .waitFor();
    assert.equal(starts, 3);
    assert.equal(await page.locator("#session-send").isDisabled(), true);
    console.log("GUI_PROTOCOL_SESSION_LIFECYCLE_PASS");
  } catch (error) {
    primary = error;
  } finally {
    await finishHeldRoute(
      held,
      () => page.unroute(pattern, handler),
      primary || routeFailure,
    );
  }
}
