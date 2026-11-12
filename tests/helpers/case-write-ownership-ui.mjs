import assert from "node:assert/strict";
import { createImportOwnershipFixture } from "./project-import-ownership-ui.mjs";
export async function exerciseCaseWriteOwnership(page) {
  await createImportOwnershipFixture(page);
  await page.locator('.rail [data-page="apis"]').click();
  await page.locator("#add-request").click();
  await page.locator("#request-name").fill("Case source");
  const id = await page.locator("#project-select").inputValue();
  const endpoint = new URL("/api/projects/" + id, page.url()).href;
  await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url() === endpoint &&
        r.request().method() === "PUT" &&
        r.status() === 200,
    ),
    page.locator("#save").click(),
  ]);
  await page
    .locator("#saved-state")
    .getByText("✓ 已保存", { exact: true })
    .waitFor();
  let posts = 0,
    puts = 0,
    release,
    ready,
    timer;
  const held = new Promise((r) => (release = r)),
    received = new Promise((r) => (ready = r));
  const observe = (request) => {
    if (request.url() === endpoint && request.method() === "PUT") puts++;
  };
  const handler = async (route) => {
    posts++;
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    const saved = await response.json();
    assert(saved.project.cases.some((c) => c.name === "Late saved case"));
    ready();
    await held;
    await route.fulfill({ response });
  };
  page.on("request", observe);
  await page.route(endpoint + "/cases", handler);
  try {
    await page.locator('[data-mode="cases"]').click();
    await page.locator("#new-interface-case").click();
    await page.locator("#case-name").fill("Late saved case");
    await page.locator("#dialog-save").click();
    await Promise.race([
      received,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("case response timeout")), 15000);
      }),
    ]);
    await page.keyboard.press("Escape");
    await page.locator("#dialog").waitFor({ state: "hidden" });
    await page.locator("#request-name").fill("Newer case source draft");
    release();
    await page
      .locator("#toast")
      .getByText(/用例可能已写入原项目/)
      .waitFor();
    assert.equal(
      await page.locator("#request-name").inputValue(),
      "Newer case source draft",
    );
    await page.locator("#save").click();
    await page
      .locator("#toast")
      .getByText(/核对用例保存结果/)
      .waitFor();
    assert.equal(
      puts,
      0,
      "unknown result cannot be overwritten with stale project",
    );
    await page.locator("#new-interface-case").click();
    await page.locator("#dialog-save").click();
    await page
      .locator("#toast")
      .getByText(/核对用例保存结果/)
      .waitFor();
    assert.equal(
      posts,
      1,
      "unknown committed case cannot be blindly submitted again",
    );
    await page.keyboard.press("Escape");
    await page.locator("#dialog").waitFor({ state: "hidden" });
    const discard = (dialog) => dialog.accept();
    page.on("dialog", discard);
    let reloaded;
    try {
      const [response] = await Promise.all([
        page.waitForResponse(
          (r) =>
            r.url() === endpoint &&
            r.request().method() === "GET" &&
            r.status() === 200,
        ),
        page.locator("#project-select").selectOption(id),
      ]);
      reloaded = await response.json();
      await page.waitForFunction(
        () => document.querySelector("#request-name")?.value === "Case source",
      );
    } finally {
      page.off("dialog", discard);
    }
    assert.equal(
      reloaded.cases.filter((c) => c.name === "Late saved case").length,
      1,
    );
    await page.locator("#request-name").fill("Reconciled case source");
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url() === endpoint &&
          r.request().method() === "PUT" &&
          r.status() === 200,
      ),
      page.locator("#save").click(),
    ]);
    assert.equal(puts, 1);
    assert.equal(posts, 1);
    await page.screenshot({ path: "/tmp/local-api-case-write-ownership.png" });
    console.log("GUI_CASE_WRITE_OWNERSHIP_PASS");
  } finally {
    clearTimeout(timer);
    release();
    await page.unroute(endpoint + "/cases", handler);
    page.off("request", observe);
  }
}
