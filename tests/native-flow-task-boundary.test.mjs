import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { prepareDirectoryPlans } from "../src/apipost-execution-plans.mjs";
import { normalizeRequest, snapshotPlan, runPlan } from "../src/core.mjs";
import { executeRequest } from "../src/runtime.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";
test("native flow boundary removes executable API tasks and retains inert source before step scripts", async (t) => {
  const seen = [],
    server = http.createServer((req, res) => {
      seen.push(req.headers["x-step"]);
      res.setHeader("content-type", "application/json");
      res.end('{"value":"step-response"}');
    });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const source = modernApipostFixture(),
    api = source.apis.find((a) => a.target_type === "api");
  source.global.servers = [];
  source.global.envs[0].server_list = [];
  api.url = `http://127.0.0.1:${server.address().port}/`;
  delete api.service_id;
  api.project_id = source.project_id;
  const flow = {
    flow_id: "flow-boundary",
    project_id: source.project_id,
    name: "Boundary",
    description: "",
    source: "manual",
    environment_id: "1",
    created_at: "2026-10-26T00:00:00Z",
    updated_at: "2026-10-26T00:00:00Z",
    steps: [
      {
        step_id: "step",
        target_id: api.target_id,
        api_snapshot: structuredClone(api),
        pre_script: 'apt.setRequestHeader("x-step","owned");',
        post_script:
          'if(apt.response.json().value!=="step-response")throw Error("bad response");',
      },
    ],
  };
  const before = JSON.stringify({ source, flow });
  let intermediate;
  // The normalizer extension models executable fields added by the separate
  // native-task feature; assert the boundary before snapshot normalization.
  const plans = prepareDirectoryPlans(
    source,
    [flow],
    { plans: [] },
    {
      normalizeRequest: (input) => ({
        ...normalizeRequest(input),
        nativeTasks: {
          version: 1,
          before: [
            {
              type: "customScript",
              enabled: 1,
              data: 'throw Error("API task")',
            },
          ],
          after: [],
        },
        importedScriptTasks: {
          version: 1,
          before: [
            {
              type: "customScript",
              enabled: 1,
              id: "provenance",
              name: "Provenance",
              data: 'throw Error("API provenance")',
            },
          ],
          after: [],
        },
        assertions: [{ target: "status", op: "eq", value: 418 }],
        extract: [{ name: "forbidden", path: "$.value", scope: "environment" }],
      }),
      snapshotPlan: (input) => {
        intermediate = structuredClone(input);
        return snapshotPlan(input);
      },
    },
  );
  const request = intermediate.steps[0].request;
  assert.equal(request.nativeTasks, undefined);
  assert.match(request.importedNativeTaskSource.before[0].data, /API task/);
  assert.deepEqual(
    plans[0].steps[0].request.importedNativeTaskSource,
    request.importedNativeTaskSource,
  );
  assert.match(request.importedScriptTasks.before[0].data, /API provenance/);
  assert.deepEqual(request.assertions, []);
  assert.deepEqual(request.extract, []);
  const result = await runPlan(plans[0], { shared: "current" }, executeRequest);
  assert.equal(result.status, "passed", JSON.stringify(result));
  assert.deepEqual(seen, ["owned"]);
  assert.equal(result.variables.forbidden, undefined);
  assert.equal(JSON.stringify({ source, flow }), before);
});
