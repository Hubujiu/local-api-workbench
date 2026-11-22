export async function pickProjectUI(page, id) {
  const select = page.locator("#project-select");
  const owned = select.locator("option[selected]");
  if ((await owned.getAttribute("value")) !== id) await select.selectOption(id);
  await page.waitForFunction(
    (id) =>
      document.querySelector("#project-select option[selected]")?.value === id,
    id,
  );
}
