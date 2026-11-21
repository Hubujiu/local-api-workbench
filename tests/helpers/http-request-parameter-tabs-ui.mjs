import assert from "node:assert/strict";

export async function exerciseRequestParameterTabs(page) {
  const viewport = page.viewportSize();
  const layout = page.locator("#response-layout");
  const wasSplit = (await layout.getAttribute("aria-pressed")) === "true";
  const editor = page.locator('.editor[data-editor-mode="debug"]');
  const strip = editor.getByRole("group", { name: "请求参数" });
  const tab = (id) => strip.locator(`[data-param="${id}"]`);
  const initial = await strip
    .locator("[aria-pressed=true]")
    .getAttribute("data-param");
  const url = await editor.locator("#url").inputValue();
  const focusAndSelect = async (id) => {
    await tab(id).focus();
    await page.keyboard.press("Enter");
    assert.equal(await tab(id).getAttribute("aria-pressed"), "true");
    assert.equal(
      await tab(id).evaluate((node) => node === document.activeElement),
      true,
    );
    const buttonBox = await tab(id).boundingBox();
    const stripBox = await strip.boundingBox();
    assert.ok(
      buttonBox.x >= stripBox.x - 1 &&
        buttonBox.x + buttonBox.width <= stripBox.x + stripBox.width + 1,
      JSON.stringify({ id, buttonBox, stripBox }),
    );
    assert.equal(await editor.locator("#url").inputValue(), url);
  };
  try {
    for (const width of [1363, 600, 360]) {
      await page.setViewportSize({ width, height: 1023 });
      await focusAndSelect("headers");
      await focusAndSelect("query");
      await focusAndSelect("body");
      await focusAndSelect("extract");
      await focusAndSelect("headers");
      if (width <= 600)
        assert.equal(
          await strip.evaluate(
            (element) => element.scrollWidth > element.clientWidth,
          ),
          true,
        );
    }
    await page.setViewportSize({ width: 900, height: 800 });
    if (!wasSplit) await layout.click();
    await editor.evaluate((element) => {
      if (!element.classList.contains("split-layout"))
        throw Error("missing split layout");
    });
    await focusAndSelect("extract");
    await focusAndSelect("headers");
  } finally {
    if (((await layout.getAttribute("aria-pressed")) === "true") !== wasSplit)
      await layout.click();
    await page.setViewportSize(viewport);
    await tab(initial).click();
  }
}
