import assert from "node:assert/strict";
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Import fixture response timeout")),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function createImportOwnershipFixture(page) {
  await page.locator("#new-project").click();
  await page.locator("#new-name").fill("Import response ownership");
  // The preceding smoke scenarios may leave a synthetic draft. Explicitly
  // discard it when opening our newly created fixture, never edit that project.
  let unexpectedDialog;
  const discardPriorFixture = async (dialog) => {
    if (
      dialog.type() === "confirm" &&
      dialog.message() === "当前修改尚未保存，确定切换项目？"
    )
      await dialog.accept();
    else {
      await dialog.dismiss();
      unexpectedDialog = dialog.message();
    }
  };
  page.on("dialog", discardPriorFixture);
  try {
    const [createdResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/projects" &&
          response.request().method() === "POST" &&
          response.status() === 201,
      ),
      page.locator("#dialog-save").click(),
    ]);
    const created = await createdResponse.json();
    await page.locator("#dialog").waitFor({ state: "hidden" });
    assert.equal(
      unexpectedDialog,
      undefined,
      "unexpected fixture setup dialog",
    );
    assert.equal(
      await page.locator("#project-select").inputValue(),
      created.id,
      "fixture must own its newly created project before adding requests",
    );
  } finally {
    page.off("dialog", discardPriorFixture);
  }
}
export async function exerciseProjectImportOwnership(page) {
  await createImportOwnershipFixture(page);
  await page.locator('.rail [data-page="apis"]').click();
  await page.locator("#add-request").click();
  await page.locator("#request-name").fill("Original request");
  await page.locator("#url").fill("http://127.0.0.1:1/never-called");
  const id = await page.locator("#project-select").inputValue();
  const endpoint = new URL(`/api/projects/${id}`, page.url()).href;
  async function save() {
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
  }
  await save();
  let posts = 0,
    puts = 0,
    mode = "delay",
    committed = deferred(),
    release = deferred();
  const observe = (request) => {
    if (request.url() === endpoint && request.method() === "PUT") puts++;
  };
  const handler = async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts++;
    try {
      // Execute the real server mutation, then delay/drop only its UI response.
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      committed.resolve(await response.json());
      if (mode === "drop") await route.abort("failed");
      else {
        await release.promise;
        await route.fulfill({ response });
      }
    } catch (error) {
      committed.reject(error);
      throw error;
    }
  };
  page.on("request", observe);
  await page.route(endpoint + "/import", handler);
  const document = (name) =>
    JSON.stringify({
      openapi: "3.0.3",
      info: { title: "fixture", version: "1" },
      servers: [{ url: "http://127.0.0.1:1" }],
      paths: {
        ["/" + name]: {
          get: { summary: name, responses: { 200: { description: "ok" } } },
        },
      },
    });
  async function submit(name) {
    await page.locator("#import").click();
    await page.locator("#import-text").fill(document(name));
    await page.locator("#dialog-save").click();
    return bounded(committed.promise);
  }
  async function reload() {
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url() === endpoint &&
          r.request().method() === "GET" &&
          r.status() === 200,
      ),
      page.locator("#project-select").selectOption(id),
    ]);
    await page.locator("#request-name").waitFor();
  }
  try {
    const saved = await submit("Delayed import");
    assert(saved.requests.some((r) => r.name === "Delayed import"));
    await page.keyboard.press("Escape");
    await page.locator("#dialog").waitFor({ state: "hidden" });
    await page.locator("#request-name").fill("New unsaved draft");
    release.resolve();
    await page
      .locator("#toast")
      .getByText(/当前草稿仍保留/)
      .waitFor();
    assert.equal(
      await page.locator("#request-name").inputValue(),
      "New unsaved draft",
    );
    assert.match(await page.locator("#saved-state").innerText(), /未保存/);
    await page.locator("#save").click();
    await page
      .locator("#toast")
      .getByText(/请重新加载原项目核对/)
      .waitFor();
    assert.equal(
      puts,
      0,
      "stale draft must not be PUT over the committed import",
    );
    assert.equal(posts, 1, "late response must not trigger an import retry");
    // Explicitly discard this synthetic draft only after proving it is preserved.
    page.once("dialog", (dialog) => dialog.accept());
    await reload();
    await page
      .locator(".sidebar [data-request]")
      .filter({ hasText: "Delayed import" })
      .waitFor();
    assert.equal(
      await page.locator("#request-name").inputValue(),
      "Original request",
    );
    await page.locator("#request-name").fill("After reconciliation");
    await save();
    assert.equal(puts, 1, "fresh readback releases the save gate");
    mode = "drop";
    committed = deferred();
    release = deferred();
    const lost = await submit("Lost response import");
    assert(lost.requests.some((r) => r.name === "Lost response import"));
    await page
      .locator("#toast")
      .getByText(/导入可能已写入原项目/)
      .waitFor();
    await page.locator("#dialog-save").click();
    await page
      .locator("#toast")
      .getByText(/请重新加载原项目核对/)
      .waitFor();
    assert.equal(posts, 2, "uncertain import must not issue a second POST");
    await page.keyboard.press("Escape");
    await page.locator("#dialog").waitFor({ state: "hidden" });
    await reload();
    await page
      .locator(".sidebar [data-request]")
      .filter({ hasText: "Lost response import" })
      .waitFor();
    assert.equal(
      await page.locator("#request-name").inputValue(),
      "After reconciliation",
    );
    assert.equal(posts, 2);
    await page.screenshot({ path: "/tmp/local-api-import-ownership.png" });
    console.log("GUI_IMPORT_RESPONSE_OWNERSHIP_PASS");
  } finally {
    release.resolve();
    await page.unroute(endpoint + "/import", handler);
    page.off("request", observe);
  }
}
