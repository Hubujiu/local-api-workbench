import assert from "node:assert/strict";
import test from "node:test";
import {
  planPickerEntries,
  renderStepPicker,
} from "../public/plan-step-picker.js";

test("picker trees combine requests in nested folders and exclude deleted ones", () => {
  const root = { id: "root" };
  const accounts = { id: "accounts", folder: "Fixtures/Accounts" };
  const payments = { id: "payments", folder: "Fixtures/Payments" };
  const direct = { id: "direct", folder: "Fixtures" };
  const unusual = { id: "unusual", folder: "older//flat" };
  assert.deepEqual(
    planPickerEntries([
      root,
      accounts,
      payments,
      direct,
      unusual,
      { id: "deleted", folder: "Hidden", deletedAt: "previously" },
    ]),
    [
      {
        name: "Fixtures",
        children: [
          { name: "Accounts", children: [{ request: accounts }] },
          { name: "Payments", children: [{ request: payments }] },
          { request: direct },
        ],
      },
      { name: "older//flat", children: [{ request: unusual }] },
      { request: root },
    ],
  );
});

test("picker renders nested disclosure controls, per-request checks and escaped labels", () => {
  const output = renderStepPicker([
    { id: 'a"b', folder: "Fixtures/<Accounts>", name: "<test>", method: "GET" },
  ]);
  assert.match(output, /aria-controls="plan-picker-folder-1"/);
  assert.match(
    output,
    /id="plan-picker-folder-1".*aria-controls="plan-picker-folder-2"/,
  );
  assert.match(output, /data-picker-path="Fixtures\/&lt;Accounts&gt;"/);
  assert.match(output, /data-picker-depth="2"/);
  assert.doesNotMatch(output, / style=/);
  assert.match(output, /value="a&quot;b"/);
  assert.match(output, /GET &lt;test&gt;/);
  assert.equal(output.match(/type="checkbox"/g)?.length, 1);
  assert.match(output, /id="plan-step-picker-empty"[^>]* hidden>/);
  assert.match(output, /id="add-step"[^>]* disabled>/);
  assert.match(
    renderStepPicker([]),
    /id="plan-step-picker-empty" class="muted" role="status" >没有匹配接口/,
  );
});
