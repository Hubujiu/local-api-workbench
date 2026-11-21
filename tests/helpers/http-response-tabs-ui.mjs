import assert from "node:assert/strict";

const cookieColumns = [
  "Name",
  "Value",
  "Domain",
  "Path",
  "Expires",
  "HttpOnly",
  "Secure",
];

export async function checkUnsentResponseData(page, name, requireScroll) {
  const body = page.locator(".response .response-body");
  const pane = body.locator(`[data-unsent-response="${name}"]`);
  await pane.getByText("暂无数据", { exact: true }).waitFor();
  assert.equal(await body.locator(".http-response-empty").count(), 0);
  const bounds = await body.boundingBox();
  const box = await pane.boundingBox();
  assert.ok(
    box.x >= bounds.x - 1 && box.x + box.width <= bounds.x + bounds.width + 1,
    JSON.stringify({ name, bounds, box }),
  );
  if (name === "headers") {
    assert.equal(await pane.getAttribute("aria-label"), "尚无响应头");
    assert.equal(await pane.getByRole("table").count(), 0);
  } else {
    const table = pane.getByRole("table", { name: "响应 Cookie" });
    assert.deepEqual(
      await table.getByRole("columnheader").allTextContents(),
      cookieColumns,
    );
    assert.equal(await table.locator("tbody td").count(), 1);
    assert.equal(await table.locator("tbody td").getAttribute("colspan"), "7");
    if (requireScroll) {
      assert.ok(await pane.evaluate((el) => el.scrollWidth > el.clientWidth));
      await pane.focus();
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(
        () =>
          document.querySelector(".unsent-response-cookie-scroll").scrollLeft >
          0,
      );
    }
  }
  return box;
}

export async function exerciseHTTPResponseTabs(page) {
  const viewport = page.viewportSize();
  const editor = page.locator('.editor[data-editor-mode="debug"]');
  const layout = page.locator("#response-layout");
  const wasSplit = (await layout.getAttribute("aria-pressed")) === "true";
  const response = editor.locator(".response");
  const strip = response.getByRole("group", { name: "响应视图" });
  const tab = (name) => strip.locator(`[data-response="${name}"]`);
  const initial = await strip
    .locator("[aria-pressed=true]")
    .getAttribute("data-response");
  const url = await editor.locator("#url").inputValue();
  const activate = async (name) => {
    await tab(name).focus();
    await page.keyboard.press("Enter");
    assert.equal(await tab(name).getAttribute("aria-pressed"), "true");
    assert.equal(
      await tab(name).evaluate((node) => node === document.activeElement),
      true,
    );
    const box = await tab(name).boundingBox();
    const scroller = await strip.boundingBox();
    assert.ok(
      box.x >= scroller.x - 1 &&
        box.x + box.width <= scroller.x + scroller.width + 1,
      JSON.stringify({ name, box, scroller }),
    );
    assert.equal(await editor.locator("#url").inputValue(), url);
  };
  try {
    await activate("body");
    const body = await response
      .locator(".response-body .http-response-empty p")
      .textContent();
    assert.deepEqual(
      await strip
        .locator("[data-response]")
        .evaluateAll((buttons) =>
          buttons.map((button) => button.dataset.response),
        ),
      [
        "body",
        "headers",
        "cookies",
        "examples",
        "request",
        "logs",
        "visualization",
        "scriptResponse",
        "assertions",
        "extracted",
      ],
    );
    for (const width of [1363, 600, 360]) {
      await page.setViewportSize({ width, height: 1023 });
      const tabBox = await strip.boundingBox();
      const topBox = await response.locator(".response-top").boundingBox();
      assert.equal(await response.locator(".metrics").isVisible(), false);
      assert.ok(
        Math.abs(tabBox.x + tabBox.width - topBox.x - topBox.width) <= 1,
      );
      await activate("headers");
      await checkUnsentResponseData(page, "headers", false);
      await activate("cookies");
      await checkUnsentResponseData(page, "cookies", width === 360);
      await activate("examples");
      assert.equal(await response.locator(".http-response-empty").count(), 0);
      await activate("extracted");
      await activate("body");
      assert.equal(
        await response.locator(".http-response-empty p").textContent(),
        body,
      );
      if (width <= 600)
        assert.equal(
          await strip.evaluate((node) => node.scrollWidth > node.clientWidth),
          true,
        );
    }
    await page.setViewportSize({ width: 900, height: 800 });
    if (!wasSplit) await layout.click();
    assert.match(await editor.getAttribute("class"), /split-layout/);
    await activate("headers");
    await checkUnsentResponseData(page, "headers", false);
    await activate("cookies");
    await checkUnsentResponseData(page, "cookies", true);
    await activate("extracted");
    await activate("body");
  } finally {
    if (((await layout.getAttribute("aria-pressed")) === "true") !== wasSplit)
      await layout.click();
    await page.setViewportSize(viewport);
    await tab(initial).click();
  }
}
