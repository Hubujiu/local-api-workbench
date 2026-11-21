import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

// Call with an already-open, isolated synthetic project, never a real workspace.
// Only switches the view; does not create a plan, execute requests, or enable MCP.
export async function capturePlanSurfaceBaseline(page, { prefix }) {
  assert.equal(
    await page.locator("body.dark").count(),
    0,
    "Light theme required",
  );
  await page.locator('.top-actions [data-page="plans"]').click();
  await page.locator(".plans-page #new-plan").waitFor();
  assert.equal(
    await page.locator(".plan-list [data-plan]").count(),
    0,
    "Empty synthetic project required",
  );
  await page.locator('.plans-page [data-plan-tab="plans"]').click();
  await page.locator(".plan-selection-empty").waitFor();
  const selectors = [
    ".plans-heading",
    ".plan-tabs",
    ".plan-layout",
    ".plan-list",
    ".plan-selection-empty",
    "#new-plan",
  ];
  const bounds = {};
  for (const selector of selectors)
    bounds[selector] = await page.locator(selector).boundingBox();
  await page.screenshot({ path: prefix + "-empty-light.png" });
  await page.locator('.plans-page [data-plan-tab="runs"]').click();
  await page.locator("#refresh-plan-history").waitFor();
  await page.screenshot({ path: prefix + "-runs-light.png" });
  await page.locator('.plans-page [data-plan-tab="plans"]').click();
  await page.locator(".plan-selection-empty").waitFor();
  await writeFile(
    prefix + "-bounds.json",
    JSON.stringify({ viewport: page.viewportSize(), bounds }, null, 2),
  );
}
