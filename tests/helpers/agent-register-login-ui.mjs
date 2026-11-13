import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerLoginScenario } from "./agent-register-login-fixture.mjs";

// Separate disposable application and loopback peer, never the user's project.
export async function exerciseAgentRegisterLoginUI(browserContext) {
  for (const failed of [false, true]) {
    const cleanups = [];
    let page;
    try {
      const { app, project, plan, run, seen } = await registerLoginScenario(
        { after: (fn) => cleanups.push(fn) },
        failed,
      );
      page = await browserContext.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(app.launchUrl);
      await page.locator("#project-select").selectOption(project.id);
      await page.locator('header button[data-page="plans"]').click();
      await page.locator(`[data-plan="${plan.id}"]`).click();
      assert.equal(await page.locator("#plan-name").inputValue(), plan.name);
      assert.equal(
        await page.locator("#plan-status-policy").inputValue(),
        "assertions",
      );
      await page
        .getByText("橙色内容由 AI 创建或修改；你可以检查并直接修改。", {
          exact: true,
        })
        .waitFor();
      await page.locator('[data-plan-tab="runs"]').click();
      const exportButton = page.locator(`[data-export-run="${run.id}"]`);
      const card = page.locator("details.card").filter({ has: exportButton });
      const summary = card.locator(":scope > summary");
      assert.match(await summary.innerText(), failed ? /× 失败/ : /✓ 通过/);
      if ((await card.getAttribute("open")) === null) await summary.click();
      await card
        .getByText(`快照 SHA256: ${run.planHash}`, { exact: true })
        .waitFor();
      assert.equal(
        await card.locator("[data-run-step]").count(),
        failed ? 1 : 2,
      );
      assert.match(
        await card.locator('[data-run-step="0"] > summary').innerText(),
        failed
          ? /failed.*Register synthetic account.*409/
          : /passed.*Register synthetic account.*201/,
      );
      if (!failed)
        assert.match(
          await card.locator('[data-run-step="1"] > summary').innerText(),
          /passed.*Login using returned user.*200/,
        );
      async function visibleEvidence(index, label) {
        const step = card.locator(`[data-run-step="${index}"]`);
        if ((await step.getAttribute("open")) === null)
          await step.locator(":scope > summary").click();
        const block = step.locator(`[data-evidence="${label}"]`);
        if ((await block.getAttribute("open")) === null)
          await block.locator(":scope > summary").click();
        const text = block.locator("pre");
        await text.waitFor({ state: "visible" });
        return JSON.parse(await text.innerText());
      }
      const registrationResponse = await visibleEvidence(0, "响应");
      assert.equal(
        JSON.parse(registrationResponse.body).userId,
        "synthetic-created-user",
      );
      assert.equal(
        (await visibleEvidence(0, "提取变量")).createdUser,
        "synthetic-created-user",
      );
      if (!failed) {
        const loginResponse = await visibleEvidence(1, "响应");
        assert.equal(JSON.parse(loginResponse.body).authenticated, true);
      }
      const pending = page.waitForEvent("download");
      await exportButton.click();
      const evidence = JSON.parse(
        await readFile(await (await pending).path(), "utf8"),
      );
      // Export is the stored record (transport receipt fields are not persisted).
      assert.deepEqual(evidence.results, run.results);
      assert.equal(evidence.planHash, run.planHash);
      assert.equal(evidence.snapshot.failurePolicy, "stop");
      if (failed) assert.equal(evidence.failureStop.stepId, "register");
      assert.equal(
        seen.length,
        failed ? 1 : 2,
        "view/export must not replay business requests",
      );
      assert.deepEqual(errors, [], "scenario page must have no script errors");
      console.log(
        "AGENT_REGISTER_LOGIN_BROWSER_PASS",
        failed ? "failure-stops-before-login" : "returned-data-login",
      );
    } finally {
      if (page) await page.close();
      for (const cleanup of cleanups.reverse()) await cleanup();
    }
  }
}
