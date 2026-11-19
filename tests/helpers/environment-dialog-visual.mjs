import assert from "node:assert/strict";
export async function exerciseEnvironmentDialogVisual(page, { prefix } = {}) {
  await page.locator('.rail [data-page="settings"]').click();
  await page.locator('[data-settings-anchor="settings-environments"]').click();
  await page.locator("#add-env").click();
  await page.locator("#env-name").waitFor();
  assert.equal(await page.locator("#dialog-title").textContent(), "环境设置");
  assert.equal(await page.locator("#dialog").evaluate((d) => d.open), true);
  if (prefix) await page.screenshot({ path: prefix + "-new-light.png" });
  await page.locator("#env-name").fill("视觉环境");
  await page.locator("[data-env-value]").fill('"https://example.test"');
  await page.locator("#environment-variable-add").click();
  await page.locator("[data-env-key]").last().fill("count");
  await page.locator("[data-env-value]").last().fill("42");
  await page.locator("#environment-save-stay").click();
  assert.equal(await page.locator("#dialog").evaluate((d) => d.open), true);
  assert.equal(await page.locator("#edit-env-name").inputValue(), "视觉环境");
  await page.locator("#environment-save-stay").click();
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  const card = page
    .locator(".card")
    .filter({ has: page.getByText("视觉环境", { exact: true }) });
  assert.equal(await card.count(), 1);
  await card.locator("[data-edit-env]").click();
  assert.equal(await page.locator("#edit-env-name").inputValue(), "视觉环境");
  assert.equal(
    await page.locator("[data-env-value]").last().inputValue(),
    "42",
  );
  if (prefix) await page.screenshot({ path: prefix + "-edit-light.png" });
  await page.locator("#edit-env-name").fill("取消不应保存");
  await page.keyboard.press("Escape");
  await card.locator("[data-edit-env]").click();
  assert.equal(await page.locator("#edit-env-name").inputValue(), "视觉环境");
  await page.locator(".environment-json summary").click();
  await page
    .locator("#modal-json")
    .fill('{"object":{"nested":true},"count":0}');
  await page.locator("#dialog-save").click();
  await card.locator("[data-edit-env]").click();
  const saved = JSON.parse(await page.locator("#modal-json").inputValue());
  assert.deepEqual(saved, { object: { nested: true }, count: 0 });
  await page.setViewportSize({ width: 600, height: 848 });
  if (prefix) await page.screenshot({ path: prefix + "-narrow.png" });
  await page.keyboard.press("Escape");
}
