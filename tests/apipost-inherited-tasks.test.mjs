import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { importIntoProject, importDocument, runPlan } from "../src/core.mjs";
import { executeRequest } from "../src/runtime.mjs";
import {
  resolveServiceRequest,
  environmentVariables,
} from "../src/environments.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";
const task = (id, data, enabled = 1) => ({
  type: "customScript",
  id,
  name: id,
  enabled,
  data,
});
const project = () => ({
  requests: [],
  folders: [],
  environments: [],
  servers: [],
  globalVariables: {},
  settings: { statuses: [] },
});

test("modern inherited custom scripts flatten project-to-leaf in one lexical scope and retain readonly origins", async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers["x-order"]);
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const source = modernApipostFixture();
  source.global.envs[0].server_list[0].uri =
    "http://127.0.0.1:" + server.address().port;
  source.global.global_param.pre_tasks = [
    task("global", 'const order=["project"];'),
  ];
  source.apis[0].request.pre_tasks = [
    task("folder", 'order.push("folder");'),
    task("off", 'throw Error("off")', 0),
  ];
  source.apis[1].request.pre_tasks = [
    task(
      "leaf",
      'order.push("request");pm.setRequestHeader("x-order",order.join(","));',
    ),
  ];
  source.global.global_param.post_tasks = [
    task("global-after", 'const afterOrder=["project"];'),
  ];
  source.apis[0].request.post_tasks = [
    task("folder-after", 'afterOrder.push("folder");'),
  ];
  source.apis[1].request.post_tasks = [
    task(
      "leaf-after",
      'pm.test("inherited after",()=>pm.expect(afterOrder.join(",")).to.equal("project,folder,inner"));',
    ),
  ];
  source.apis[1].parent_id = "inner";
  source.apis.push({
    target_id: "inner",
    target_type: "folder",
    name: "Inner",
    parent_id: "folder",
    request: {
      pre_tasks: [task("inner", 'order.push("inner");')],
      post_tasks: [task("inner-after", 'afterOrder.push("inner");')],
    },
  });
  const original = structuredClone(source),
    p = project();
  importIntoProject(p, source);
  assert.deepEqual(source, original);
  const request = p.requests[0];
  assert.deepEqual(
    request.importedScriptTasks.before.map((x) => x.origin.scope),
    ["project", "folder", "folder", "folder", "request"],
  );
  assert.deepEqual(
    request.importedScriptTasks.before.map((x) => x.id),
    ["global", "folder", "off", "inner", "leaf"],
  );
  assert.match(request.importNotes.join("\n"), /快照/);
  const restored = importDocument(JSON.stringify({ requests: [request] }))[0];
  assert.deepEqual(restored.importedScriptTasks, request.importedScriptTasks);
  const environment = p.environments[0];
  const result = await runPlan(
    {
      steps: [{ request: resolveServiceRequest(p, restored, environment.id) }],
    },
    environmentVariables(p, environment.id),
    executeRequest,
  );
  assert.equal(result.status, "passed", JSON.stringify(result));
  assert.deepEqual(seen, ["project,folder,inner,request"]);
});

test("inherited tasks enforce combined limits and reject orphan or unsupported sources atomically", () => {
  for (const change of [
    (d) => {
      d.global.global_param.pre_tasks = [task("global", "x".repeat(40000))];
      d.apis[1].request.pre_tasks = [task("local", "x".repeat(30000))];
    },
    (d) => {
      d.global.global_param.pre_tasks = Array.from({ length: 9 }, (_, i) =>
        task("g" + i, ""),
      );
      d.apis[1].request.pre_tasks = Array.from({ length: 8 }, (_, i) =>
        task("l" + i, ""),
      );
    },
    (d) => {
      d.apis[0].request.pre_tasks = [{ ...task("bad", ""), type: "database" }];
    },
    (d) => {
      d.apis[0].request.pre_tasks = [task("orphan", "")];
      d.apis.pop();
    },
    (d) => {
      d.global.global_param.pre_tasks = [task("orphan", "")];
      d.apis = [];
    },
    (d) => {
      d.apis[0].request.pre_tasks = [
        { ...task("bad", ""), origin: { scope: "project", id: "forged" } },
      ];
    },
  ]) {
    const source = modernApipostFixture(),
      p = project(),
      original = structuredClone(p);
    change(source);
    assert.throws(() => importIntoProject(p, source));
    assert.deepEqual(p, original);
  }
});
