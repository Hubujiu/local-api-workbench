import assert from "node:assert/strict";
import { createImportOwnershipFixture } from "./project-import-ownership-ui.mjs";
export async function exerciseGeneratedBodyOwnership(page) {
  await createImportOwnershipFixture(page);
  await page.locator('.rail [data-page="apis"]').click();
  await page.locator("#add-request").click();
  await page.locator('[data-mode="design"]').click();
  await page.locator("#schema").fill(
    JSON.stringify({
      type: "object",
      properties: { value: { const: "owned sample" } },
      required: ["value"],
    }),
  );
  await page.locator('[data-mode="debug"]').click();
  await page.locator('[data-param="body"]').click();
  // Establish a JSON editor and preserve an existing draft before the slow call.
  await page.locator('input[name="body-type"][value="raw"]').check();
  await page.locator("#raw-format").selectOption("json");
  await page.locator("#body-code").fill('{"draft":"before"}');
  const id = await page.locator("#project-select").inputValue();
  const endpoint = new URL("/api/projects/" + id + "/sample", page.url()).href;
  let release,
    received,
    posts = 0;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const ready = new Promise((resolve) => {
    received = resolve;
  });
  const handler = async (route) => {
    posts++;
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    assert.deepEqual((await response.json()).sample, { value: "owned sample" });
    received();
    await held;
    await route.fulfill({ response });
  };
  await page.route(endpoint, handler);
  let timer;
  try {
    await page.locator("#generate-body").click();
    await Promise.race([
      ready,
      new Promise(
        (_, reject) =>
          (timer = setTimeout(
            () => reject(Error("sample response timeout")),
            15000,
          )),
      ),
    ]);
    await page.locator("#body-code").fill('{"draft":"newer"}');
    release();
    await page
      .locator("#toast")
      .getByText(/未应用生成结果/)
      .waitFor();
    assert.equal(
      await page.locator("#body-code").inputValue(),
      '{"draft":"newer"}',
    );
    assert.match(await page.locator("#saved-state").innerText(), /未保存/);
    assert.equal(posts, 1);
  } finally {
    clearTimeout(timer);
    release();
    await page.unroute(endpoint, handler);
  }
  // A fresh explicit generation still works after the stale response is refused.
  await page.locator("#generate-body").click();
  await page.waitForFunction(() => {
    try {
      return (
        JSON.parse(document.querySelector("#body-code").value).value ===
        "owned sample"
      );
    } catch {
      return false;
    }
  });
  assert.deepEqual(JSON.parse(await page.locator("#body-code").inputValue()), {
    value: "owned sample",
  });
  await page.screenshot({
    path: "/tmp/local-api-generated-body-ownership.png",
  });
  console.log("GUI_GENERATED_BODY_OWNERSHIP_PASS");
}
