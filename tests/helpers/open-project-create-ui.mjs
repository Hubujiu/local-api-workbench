export async function openProjectCreateUI(page) {
  await page.locator("#new-project").click();
  await page.locator("#project-menu-create").click();
}
