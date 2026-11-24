import assert from "node:assert/strict";

export async function exerciseHTTPRequestActions(page) {
  const priorViewport = page.viewportSize();
  const debug = page.locator('.editor[data-editor-mode="debug"]');
  const bar = debug.locator(".urlbar");
  const actions = ["发送请求", "保存请求"].map((name) =>
    bar.getByRole("group", { name, exact: true }),
  );
  const initialURL = await bar.locator("#url").inputValue();
  const closeWithKeyboard = async (action, firstItem) => {
    const disclosure = action.locator("summary");
    await disclosure.focus();
    await page.keyboard.press("Enter");
    assert.equal(await action.locator("details").evaluate((d) => d.open), true);
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      firstItem,
    );
    const item = action.locator("#" + firstItem);
    assert.equal(
      await item.evaluate((button) => {
        const { left, width, top, height } = button.getBoundingClientRect();
        return button.contains(
          document.elementFromPoint(left + width / 2, top + height / 2),
        );
      }),
      true,
      "the popup must be in view and unobscured",
    );
    await page.keyboard.press("Escape");
    assert.equal(
      await action.locator("details").evaluate((d) => d.open),
      false,
    );
    assert.equal(
      await disclosure.evaluate((e) => e === document.activeElement),
      true,
      "Escape returns focus to the same disclosure",
    );
  };
  try {
    for (const width of [1363, 600, 360]) {
      await page.setViewportSize({ width, height: 980 });
      const url = await bar.locator(".url-input").boundingBox();
      const barBox = await bar.boundingBox();
      assert.ok(url.x + url.width <= barBox.x + barBox.width + 1);
      for (const group of actions) {
        const main = await group.locator(":scope > button").boundingBox();
        const trigger = await group.locator("summary").boundingBox();
        assert.equal(main.height, 40);
        assert.equal(trigger.height, 40);
        assert.equal(main.y, trigger.y);
        assert.equal(main.x + main.width, trigger.x, "split buttons touch");
        assert.equal(main.width + trigger.width, 93);
        assert.ok(trigger.x + trigger.width <= barBox.x + barBox.width + 1);
      }
      if (width === 1363) {
        const send = await actions[0].boundingBox();
        const save = await actions[1].boundingBox();
        assert.equal(send.x - (url.x + url.width), 8);
        assert.equal(save.x - (send.x + send.width), 8);
        assert.equal(save.x + save.width, barBox.x + barBox.width);
      }
      await closeWithKeyboard(actions[0], "send-menu-curl");
      await closeWithKeyboard(actions[1], "save-menu-copy");
      assert.equal(await bar.locator("#url").inputValue(), initialURL);
    }
    assert.equal(
      await debug
        .locator(".subnav")
        .getByRole("button", { name: "生成 cURL", exact: true })
        .count(),
      1,
    );
    assert.equal(await bar.locator("#curl").count(), 0);
  } finally {
    await page.setViewportSize(priorViewport);
  }
}
