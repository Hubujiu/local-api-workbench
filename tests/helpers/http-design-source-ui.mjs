import assert from "node:assert/strict";

export async function fillHTTPDesignSchema(page, value) {
  const source = page.locator(".http-design-page .design-schema-source");
  if (!(await source.evaluate((details) => details.open)))
    await source
      .locator(":scope > summary")
      .filter({ hasText: /^JSON Schema 源编辑$/ })
      .click();
  assert.equal(await source.evaluate((details) => details.open), true);
  const editor = source.locator("#schema");
  await editor.waitFor({ state: "visible" });
  await editor.fill(value);
}
