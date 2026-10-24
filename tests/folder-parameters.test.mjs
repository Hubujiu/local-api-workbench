import test from "node:test";
import assert from "node:assert/strict";
import { applyGlobalParameters } from "../src/global-parameters.mjs";
import {
  validateFolderParameters,
  renameFolderParameters,
} from "../public/global-parameters.js";
import { normalizeRequest } from "../src/core.mjs";
import { versionPlan } from "../src/plan-version.mjs";
const row = (key, value, enabled = true) => ({ key, value, enabled });
test("exact folder defaults override global rows and never leak into siblings or descendants", () => {
  const project = {
    settings: {
      globalParameters: {
        headers: [row("X-Shared", "global"), row("X-Muted", "global")],
      },
      folderParameters: {
        Orders: {
          headers: [row("x-shared", "folder"), row("x-muted", "", false)],
          query: [row("scope", "orders")],
        },
        Other: { query: [row("scope", "other")] },
      },
    },
  };
  const request = normalizeRequest({
    folder: "Orders",
    url: "https://example.test",
  });
  const resolved = applyGlobalParameters(project, request);
  assert.deepEqual(resolved.headers, [row("x-shared", "folder")]);
  assert.deepEqual(resolved.query, [row("scope", "orders")]);
  assert.deepEqual(
    applyGlobalParameters(project, {
      ...request,
      headers: [row("X-SHARED", "local")],
    }).headers,
    [row("X-SHARED", "local")],
  );
  assert.deepEqual(
    applyGlobalParameters(project, { ...request, folder: "Orders/Child" })
      .query,
    [],
  );
  assert.deepEqual(
    applyGlobalParameters(project, { ...request, folder: "Other" }).query,
    [row("scope", "other")],
  );
  assert.deepEqual(
    applyGlobalParameters(project, {
      ...request,
      inheritGlobalParameters: false,
    }).headers,
    [],
  );
  const plan = versionPlan(null, { steps: [{ request }] }, "manual", project);
  project.settings.folderParameters.Orders.headers[0].value = "changed";
  assert.equal(
    applyGlobalParameters(project, plan.steps[0].request).headers[0].value,
    "folder",
  );
});
test("folder parameter rename and deletion are atomic and preserve independent snapshots", () => {
  const original = {
    Orders: { query: [row("q", "original")] },
    Other: { headers: [] },
  };
  const changed = renameFolderParameters(original, "Orders", "Renamed");
  assert.equal(changed.Renamed.query[0].value, "original");
  assert.equal(changed.Orders, undefined);
  assert(original.Orders);
  assert.deepEqual(renameFolderParameters(original, "Orders", null), {
    Other: { headers: [] },
  });
  assert.throws(
    () => renameFolderParameters(original, "Orders", "Other"),
    /已存在/,
  );
  assert(original.Orders);
  for (const value of [
    null,
    [],
    JSON.parse('{"__proto__":{}}'),
    { "": {} },
    { Orders: { unknown: [] } },
  ])
    assert.throws(() => validateFolderParameters(value));
  assert.deepEqual(validateFolderParameters(undefined), {});
});
