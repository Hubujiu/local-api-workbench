import { exerciseVisualPlanControls } from "./plan-control-ui.mjs";
import assert from "node:assert/strict";
import { createImportOwnershipFixture } from "./project-import-ownership-ui.mjs";
export async function exercisePlanStructureEditor(page) {
  await createImportOwnershipFixture(page);
  await page.locator('[data-page="plans"]').click();
  await page.locator("#new-plan").click();
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.locator("#edit-plan").click();
  const plan = JSON.parse(await page.locator("#modal-json").inputValue());
  plan.name = "Nested plan editor proof";
  plan.steps = [
    {
      id: "repeat-proof",
      type: "repeat",
      count: 2,
      steps: [
        {
          id: "if-proof",
          type: "if",
          condition: {
            op: "eq",
            left: { literal: true },
            right: { literal: true },
          },
          steps: [
            {
              id: "http-proof",
              request: {
                method: "GET",
                url: "http://127.0.0.1:1/not-executed",
              },
            },
          ],
        },
      ],
    },
    {
      id: "sse-proof",
      type: "protocol",
      protocol: {
        definition: { type: "sse", url: "http://127.0.0.1:1/events" },
      },
      enabled: false,
    },
  ];
  await page.locator("#modal-json").fill(JSON.stringify(plan));
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.locator('[data-plan-node="1.1.1"]').waitFor();
  assert.match(
    await page.locator('[data-plan-node="1.1.1"]').textContent(),
    /GET/,
  );
  await page.locator('[data-step-edit="0"]').click();
  await page.locator("[data-control-mode]").selectOption("json");
  const original = JSON.parse(
    await page.locator("[data-step-json]").inputValue(),
  );
  const changed = structuredClone(original);
  changed.count = 3;
  await page.locator("[data-step-json]").fill(JSON.stringify(changed));
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.reload();
  await page.locator('[data-page="plans"]').click();
  await page.locator(`[data-plan="${plan.id}"]`).click();
  await page.locator('[data-step-edit="0"]').click();
  await page.locator("[data-control-mode]").selectOption("json");
  const persisted = JSON.parse(
    await page.locator("[data-step-json]").inputValue(),
  );
  assert.equal(persisted.count, 3);
  assert.deepEqual(persisted.steps, original.steps);
  assert.equal(persisted.id, original.id);
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.locator('[data-step-edit="1"]').click();
  const protocol = JSON.parse(
    await page.locator("[data-step-json]").inputValue(),
  );
  assert.equal(protocol.protocol.definition.type, "sse");
  assert.equal(protocol.enabled, false);
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await exerciseVisualPlanControls(page, plan.id);
  console.log(
    "Nested plan and protocol editor: real server save/reload PASS (no transport executed)",
  );
}
