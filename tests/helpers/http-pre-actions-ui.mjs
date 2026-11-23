export async function revealDebugPreSettings(page, { script = true } = {}) {
  const advanced = page.locator("#http-pre-advanced");
  if (!(await advanced.count())) return;
  if (script && !(await page.locator("#script-code").isVisible())) {
    await page.locator("#http-pre-add").click();
    await page
      .locator("#http-pre-menu")
      .getByRole("menuitem", { name: "自定义脚本", exact: true })
      .click();
  }
  if (!(await advanced.evaluate((el) => el.open)))
    await advanced.locator(":scope > summary").click();
}
