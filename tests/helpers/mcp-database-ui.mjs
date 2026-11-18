import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

export async function exerciseMCPDatabaseUI(page, root) {
  const id = await page.locator("#project-select").inputValue();
  const filename = path.join(root, "mcp-授权 browser.db");
  new DatabaseSync(filename).close();
  const endpoint = new URL(
    `/api/projects/${id}/mcp-database-connections`,
    page.url(),
  ).href;
  const fields = page.locator("#mcp-db-fields");
  const policy = await page.evaluate(async () => {
    const response = await fetch("/api/mcp/config", {
      headers: { "x-local-token": sessionStorage.getItem("local-api-token") },
    });
    if (!response.ok) throw Error("MCP owner configuration read failed");
    const config = await response.json();
    return {
      enabled: config.enabled,
      write: config.write,
      execute: config.execute,
      projects: config.projects,
    };
  });
  assert.equal(
    policy.enabled &&
      policy.write &&
      policy.execute &&
      policy.projects.includes(id),
    false,
    "fixture must start without database grant authority",
  );
  await page.waitForFunction(() => {
    const fieldset = document.querySelector("#mcp-db-fields");
    return (
      fieldset?.disabled === true &&
      fieldset.matches(":disabled") &&
      document
        .querySelector("#mcp-db-policy")
        .textContent.startsWith("未开放：")
    );
  });
  assert.deepEqual(
    await fields.evaluate((element) => ({
      tag: element.tagName,
      disabled: element.disabled,
      nativeDisabled: element.matches(":disabled"),
    })),
    { tag: "FIELDSET", disabled: true, nativeDisabled: true },
  );
  for (const control of await fields
    .locator("input, select, textarea, button")
    .all())
    assert(
      await control.isDisabled(),
      "all real controls must inherit native fieldset denial",
    );
  assert(await page.locator("#mcp-db-refresh").isDisabled());
  const deniedRequests = [];
  const observeDenied = (request) => {
    if (request.url() === endpoint) deniedRequests.push(request.method());
  };
  page.on("request", observeDenied);
  try {
    await page.locator("#mcp-db-form").dispatchEvent("submit");
    await page.locator("#mcp-db-refresh").dispatchEvent("click");
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    assert.deepEqual(
      deniedRequests,
      [],
      "denied handlers must not send even a read or grant request",
    );
  } finally {
    page.off("request", observeDenied);
  }
  async function configure() {
    await page.locator("#mcp-config").click();
    await page.locator("#mcp-enabled").check();
    await page.locator("#mcp-write").check();
    await page.locator("#mcp-execute").check();
    for (const item of await page.locator("[data-mcp-project]").all()) {
      await item.setChecked(
        (await item.getAttribute("data-mcp-project")) === id,
      );
    }
    await page.locator("#dialog-save").click();
    await page
      .locator("#dialog-title")
      .getByText("MCP 连接配置", { exact: true })
      .waitFor();
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page.waitForFunction(
      () => !document.querySelector("#mcp-db-fields").disabled,
    );
  }
  await configure();
  const label = '<img src=x onerror="window.mcpInjection=true">';
  const input = (name) => page.locator(`#mcp-db-form [name="${name}"]`);
  async function grant() {
    await input("name").fill(label);
    await input("filename").fill(filename);
    await input("password").evaluate((el) => (el.value = "must-be-cleared"));
    await input("confirm").check();
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url() === endpoint &&
          r.request().method() === "POST" &&
          r.status() === 200,
      ),
      page.locator('#mcp-db-form button[type="submit"]').click(),
    ]);
    await page.locator("[data-mcp-db-revoke]").waitFor();
    assert.equal(await input("password").inputValue(), "");
    assert.equal(await input("confirm").isChecked(), false);
    assert.equal(await page.locator("#mcp-db-list img").count(), 0);
    assert((await page.locator("#mcp-db-list").innerText()).includes(label));
    assert.equal(await page.evaluate(() => window.mcpInjection), undefined);
  }
  await grant();
  await page.screenshot({ path: "/tmp/local-api-mcp-database-grants.png" });
  let abortDelete = true;
  const routeHandler = async (route) => {
    if (route.request().method() === "DELETE" && abortDelete) {
      abortDelete = false;
      await route.abort("failed");
    } else await route.continue();
  };
  await page.route(endpoint, routeHandler);
  try {
    await page.locator("[data-mcp-db-revoke]").click();
    await page
      .locator("#mcp-db-message")
      .filter({ hasText: "操作未确认" })
      .waitFor();
    await page.locator("[data-mcp-db-revoke]").waitFor();
    assert.equal(await page.locator("[data-mcp-db-revoke]").count(), 1);
    await page.waitForFunction(
      () => !document.querySelector("#mcp-db-refresh").disabled,
    );
    await page.locator("[data-mcp-db-revoke]").click();
    await page
      .locator("#mcp-db-list")
      .getByText("尚未授权数据库连接")
      .waitFor();
    assert.match(await page.locator("#mcp-db-message").innerText(), /已撤销/);
  } finally {
    await page.unroute(endpoint, routeHandler);
  }
  await grant();
  await configure();
  await page.locator("#mcp-db-list").getByText("尚未授权数据库连接").waitFor();
  const serverRows = await page.evaluate(async (endpoint) => {
    const response = await fetch(endpoint, {
      headers: { "x-local-token": sessionStorage.getItem("local-api-token") },
    });
    if (!response.ok) throw Error("MCP grant list read failed");
    return response.json();
  }, endpoint);
  assert.deepEqual(serverRows, []);
}
