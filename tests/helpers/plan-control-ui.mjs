import assert from "node:assert/strict";
export async function exerciseVisualPlanControls(page, planId) {
  await verifyMultilineControlDOM(page);
  const field = (key) => page.locator(`[data-control-key="${key}"]`);
  await page.locator('[data-step-edit="0"]').click();
  assert.equal(
    await page.locator("[data-control-mode]").inputValue(),
    "visual",
  );
  await field("root:count").fill("4");
  await field("root:intervalMs").fill("20");
  await field("root:name").fill("Visual control proof");
  await field("root:untilEnabled").check();
  await field("root:left.kind").selectOption("number");
  await field("root:left.value").fill("2");
  await field("root:right.kind").selectOption("number");
  await field("root:right.value").fill("2");
  await field("0:left.kind").selectOption("text");
  await field("0:left.value").fill("done");
  await field("0:right.kind").selectOption("text");
  await field("0:right.value").fill("done");
  // Invalid visual edits cannot silently replace the draft during mode changes.
  await field("root:count").fill("0");
  await page.locator("[data-control-mode]").selectOption("json");
  assert.equal(
    await page.locator("[data-control-mode]").inputValue(),
    "visual",
  );
  assert.equal(await page.locator("[data-control-error]").isVisible(), true);
  await field("root:count").fill("4");
  await page.locator("[data-control-mode]").selectOption("json");
  const edited = JSON.parse(
    await page.locator("[data-step-json]").inputValue(),
  );
  assert.equal(edited.count, 4);
  assert.equal(edited.untilCondition.left.literal, 2);
  assert.equal(edited.steps[0].condition.left.literal, "done");
  // Invalid JSON remains editable, not discarded or converted to visual defaults.
  await page.locator("[data-step-json]").fill("{");
  await page.locator("[data-control-mode]").selectOption("visual");
  assert.equal(await page.locator("[data-control-mode]").inputValue(), "json");
  assert.equal(await page.locator("[data-step-json]").inputValue(), "{");
  assert.equal(await page.locator("[data-control-error]").isVisible(), true);
  const firstChild = structuredClone(edited.steps[0]);
  const secondChild = structuredClone(firstChild);
  secondChild.id = "second-if-proof";
  secondChild.steps[0].id = "second-http-proof";
  secondChild.condition = {
    op: "eq",
    left: { literal: true },
    right: { literal: true },
  };
  edited.steps.push(secondChild);
  await page.locator("[data-step-json]").fill(JSON.stringify(edited));
  await page.locator("[data-control-mode]").selectOption("visual");
  // A structurally changed JSON draft must rebuild the visual fields by new path.
  await field("1:right.kind").selectOption("false");
  const [saved] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        new URL(r.url()).pathname.endsWith("/plans") &&
        r.status() === 200,
    ),
    page.locator("#dialog-save").click(),
  ]);
  const serverPlan = await saved.json();
  assert.equal(serverPlan.steps[0].count, 4);
  assert.deepEqual(serverPlan.steps[0].steps[0], firstChild);
  assert.deepEqual(serverPlan.steps[0].steps[1].condition.right, {
    literal: false,
  });
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.reload();
  await page.locator('[data-page="plans"]').click();
  await page.locator(`[data-plan="${planId}"]`).click();
  await page.locator('[data-step-edit="0"]').click();
  assert.equal(await field("root:count").inputValue(), "4");
  assert.equal(await field("root:intervalMs").inputValue(), "20");
  assert.equal(await field("0:left.kind").inputValue(), "text");
  assert.equal(await field("1:right.kind").inputValue(), "false");
  await page.locator("[data-control-mode]").selectOption("json");
  const persisted = JSON.parse(
    await page.locator("[data-step-json]").inputValue(),
  );
  assert.deepEqual(persisted, serverPlan.steps[0]);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  console.log(
    "GUI_VISUAL_PLAN_CONTROLS_PASS: typed nested repeat/if edit, invalid-mode retention, JSON structure switch, actual save and reload; no transport executed",
  );
}

async function verifyMultilineControlDOM(page) {
  const proofs = await page.evaluate(async () => {
    const { controlEditor, bindControlEditor } = await import(
      "/plan-control-editor.js"
    );
    const proofs = [];
    for (const text of [
      "\nleading\n",
      "\r\nCRLF\r\n",
      "\rCR\r",
      "变量\r\n名",
    ]) {
      for (const useVariable of [false, true]) {
        const original = {
          id: "multiline",
          type: "if",
          name: text,
          condition: {
            op: "eq",
            left: useVariable
              ? { scope: "runtime", name: text }
              : { literal: text },
            right: { literal: text },
          },
          steps: [
            {
              id: "leaf",
              request: { method: "GET", url: "http://127.0.0.1:1/no-call" },
            },
          ],
          agentFuture: { opaque: ["must", "survive"] },
        };
        const holder = document.createElement("div");
        holder.innerHTML = controlEditor(original);
        const collect = bindControlEditor(holder, original);
        const first = collect();
        const normalized = holder.querySelector(
          '[data-control-key="root:left.value"]',
        ).value;
        const mode = holder.querySelector("[data-control-mode]");
        mode.value = "json";
        mode.dispatchEvent(new Event("change"));
        const json = holder.querySelector("[data-step-json]");
        const viaJSON = JSON.parse(json.value);
        const changed = structuredClone(viaJSON);
        changed.steps.push({
          id: "second",
          request: { method: "GET", url: "http://127.0.0.1:1/second" },
        });
        json.value = JSON.stringify(changed);
        mode.value = "visual";
        mode.dispatchEvent(new Event("change"));
        const second = collect();
        holder.querySelector('[data-control-key="1:name"]').value =
          "Explicit child edit";
        const final = collect();
        proofs.push({
          original,
          first,
          viaJSON,
          changed,
          second,
          final,
          normalized,
        });
      }
    }
    return proofs;
  });
  for (const p of proofs) {
    assert.deepEqual(p.first, p.original);
    assert.deepEqual(p.viaJSON, p.original);
    assert.deepEqual(p.second, p.changed);
    assert.deepEqual(p.final, {
      ...p.changed,
      steps: [
        p.changed.steps[0],
        { ...p.changed.steps[1], name: "Explicit child edit" },
      ],
    });
    assert.equal(
      p.normalized,
      p.original.condition.left.literal?.replace(/\r\n?/g, "\n") ??
        p.original.condition.left.name.replace(/\r\n?/g, "\n"),
    );
  }
  assert(
    proofs.some(
      (p) =>
        p.normalized !==
        (p.original.condition.left.literal ?? p.original.condition.left.name),
    ),
    "actual browser CR normalization must be exercised",
  );
  console.log("GUI_VISUAL_PLAN_MULTILINE_LOSSLESS_PASS");
}
