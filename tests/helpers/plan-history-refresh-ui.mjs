import { assertHistoryRequests } from "./history-request-evidence.mjs";
import { exercisePlanHistoryFocus } from "./plan-history-focus-ui.mjs";
import {
  observeRefreshCompletion,
  exerciseHeldPlanHistoryRefresh,
} from "./plan-history-refresh-held-ui.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerLoginScenario } from "./agent-register-login-fixture.mjs";

// GUI opens before the real SDK execution. Only synthetic, disposable fixtures.
export async function exercisePlanHistoryRefreshUI(browserContext) {
  for (const failed of [false, true]) {
    const cleanups = [];
    let page, baseline;
    const errors = [],
      requests = [];
    const draft = "Unsaved GUI draft before MCP execution";
    try {
      const { app, project, run, seen } = await registerLoginScenario(
        { after: (fn) => cleanups.push(fn) },
        failed,
        async ({ app, project, seen }) => {
          page = await browserContext.newPage();
          page.on("pageerror", (error) => errors.push(error.message));
          await page.addInitScript(observeRefreshCompletion);
          await page.goto(app.launchUrl);
          const previousSelect = await page
            .locator("#project-select")
            .elementHandle();
          try {
            const [opened] = await Promise.all([
              page.waitForResponse(
                (response) =>
                  response.url() === `${app.url}/api/projects/${project.id}` &&
                  response.request().method() === "GET",
              ),
              page.locator("#project-select").selectOption(project.id),
            ]);
            assert.equal(opened.status(), 200);
            assert.equal((await opened.json()).id, project.id);
            await page.waitForFunction(
              (element) => !element.isConnected,
              previousSelect,
            );
          } finally {
            await previousSelect.dispose();
          }
          assert.equal(
            await page.locator("#project-select").inputValue(),
            project.id,
          );
          const response = await page.request.get(
            `${app.url}/api/projects/${project.id}`,
            {
              headers: { "x-local-token": app.token },
            },
          );
          assert.equal(response.status(), 200);
          baseline = await response.json();
          assert.equal(baseline.runs.length, 0);
          await page.locator('.rail [data-page="apis"]').click();
          await page.locator("#add-request").click();
          await page.locator("#request-name").fill(draft);
          await page.locator('header button[data-page="plans"]').click();
          await page.locator('[data-plan-tab="runs"]').click();
          assert.equal(await page.locator("[data-export-run]").count(), 0);
          assert.equal(
            seen.length,
            0,
            "GUI must be open before real MCP business requests",
          );
          await page
            .locator("#saved-state")
            .getByText("● 未保存", { exact: true })
            .waitFor();
          page.on("request", (request) =>
            requests.push({ url: request.url(), method: request.method() }),
          );
        },
      );
      const endpoint = `${app.url}/api/projects/${project.id}`;
      const owner = async (method = "GET", data) => {
        const response = await page.request.fetch(endpoint, {
          method,
          headers: { "x-local-token": app.token },
          ...(data === undefined ? {} : { data }),
        });
        assert.equal(response.status(), 200);
        return response.json();
      };
      // A second owner advances configuration after GUI opened. Refresh must not
      // silently adopt that CAS token while keeping the old local configuration.
      const stored = await owner();
      const concurrent = await owner("PUT", {
        ...stored,
        name: "Concurrent owner configuration",
      });
      assert.equal(concurrent.configRevision, baseline.configRevision + 1);
      const record = concurrent.runs.find((item) => item.id === run.id);
      assert.ok(record);
      assert.equal(
        await page.locator("[data-export-run]").count(),
        0,
        "no automatic history adoption",
      );
      const peerBefore = structuredClone(seen);
      await exerciseHeldPlanHistoryRefresh(page, endpoint, run.id, requests);
      assert.deepEqual(
        seen,
        peerBefore,
        "held GET must not replay peer requests",
      );
      assert.deepEqual(await owner(), concurrent);
      const refreshReadsBefore = requests.filter(
        (r) => r.url === endpoint && r.method === "GET",
      ).length;
      const refresh = async () => {
        await page.locator("#refresh-plan-history").click();
        await page
          .locator("#plan-history-refresh-status")
          .getByText("已刷新已保存记录；草稿和项目版本未变。", { exact: true })
          .waitFor();
      };
      await refresh();
      const exportButton = page.locator(`[data-export-run="${run.id}"]`);
      const card = page.locator("details.card").filter({ has: exportButton });
      assert.equal(
        await card.locator(":scope > summary .plan-run-verdict").innerText(),
        failed ? "失败" : "通过",
      );
      await card.locator(":scope > summary").click();
      await card
        .getByText(`快照 SHA256: ${run.planHash}`, { exact: true })
        .waitFor();
      assert.equal(
        await card.locator("[data-run-step]").count(),
        failed ? 1 : 2,
      );
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        exportButton.click(),
      ]);
      assert.deepEqual(
        JSON.parse(await readFile(await download.path(), "utf8")),
        record,
      );
      await exercisePlanHistoryFocus(page, endpoint, run.id);
      await refresh();
      assert.equal(
        await page.locator(`[data-export-run="${run.id}"]`).count(),
        1,
      );
      assert.deepEqual(
        seen,
        peerBefore,
        "refresh/export must not replay real peer requests",
      );
      assert.deepEqual(
        await owner(),
        concurrent,
        "GUI refresh must not commit project changes",
      );
      assert.equal(
        requests.filter((r) => r.url === endpoint && r.method === "GET")
          .length - refreshReadsBefore,
        3,
      );
      assert.deepEqual(
        requests.filter((r) => !["GET", "HEAD"].includes(r.method)),
        [],
      );

      // Failed read retains the already displayed evidence and does not retry.
      let failureReads = 0;
      await page.route(endpoint, (route) => {
        assert.equal(route.request().method(), "GET");
        failureReads++;
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Synthetic read unavailable" }),
        });
      });
      await page.locator("#refresh-plan-history").click();
      await page
        .locator("#plan-history-refresh-status")
        .getByText("Synthetic read unavailable", { exact: true })
        .waitFor();
      assert.equal(failureReads, 1);
      assert.equal(
        await page.locator(`[data-export-run="${run.id}"]`).count(),
        1,
      );
      await page.unroute(endpoint);
      await page.locator('.rail [data-page="apis"]').click();
      assert.equal(await page.locator("#request-name").inputValue(), draft);
      await page
        .locator("#saved-state")
        .getByText("● 未保存", { exact: true })
        .waitFor();
      const beforeSave = requests.length;
      const [rejected] = await Promise.all([
        page.waitForResponse(
          (r) => r.url() === endpoint && r.request().method() === "PUT",
        ),
        page.locator("#save").click(),
      ]);
      assert.equal(rejected.status(), 400);
      assert.equal(
        rejected.request().postDataJSON().configRevision,
        baseline.configRevision,
      );
      const receipt = await rejected.json();
      assert.equal(receipt.commit_outcome, "not_committed");
      assert.equal(receipt.retry_safe, false);
      await page
        .locator("#toast")
        .getByText(receipt.error, { exact: true })
        .waitFor();
      assert.equal(await page.locator("#request-name").inputValue(), draft);
      assert.deepEqual(await owner(), concurrent);
      assertHistoryRequests(
        requests.slice(beforeSave),
        [{ url: endpoint, method: "PUT" }],
        endpoint,
      );
      assert.deepEqual(seen, peerBefore);
      assert.deepEqual(errors, []);
      console.log(
        "PLAN_HISTORY_REFRESH_BROWSER_PASS",
        failed ? "failure-stop" : "register-login",
        "GUI-before-MCP/draft/CAS/export/no-replay",
      );
    } finally {
      if (page) await page.close();
      for (const cleanup of cleanups.reverse()) await cleanup();
    }
  }
}
