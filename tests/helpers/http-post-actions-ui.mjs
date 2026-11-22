export async function revealDebugPostSettings(page) {
  const advanced = page.locator("#http-post-advanced");
  if ((await advanced.count()) && !(await advanced.evaluate((el) => el.open)))
    await advanced.locator("summary").click();
}
