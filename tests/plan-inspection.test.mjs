import assert from "node:assert/strict";
import test from "node:test";
import {
  planEnvironmentInspection,
  planStepInspection,
} from "../public/plan-inspection.js";
import { renderPlans } from "../public/plan-view.js";

test("environment inspection tracks names and presence but never renders values, descriptions or addresses", () => {
  const service = { id: "one", name: "<Default service>" };
  const environment = {
    id: "two",
    variables: { count: 0, opaque: { a: "private environment" } },
    variableDefinitions: {
      count: { initialValue: "private initial" },
      "<name>": {
        initialValue: "private initial",
        description: "private description",
      },
    },
    serverUrls: { one: "https://private-service.invalid/private" },
  };
  const project = {
    servers: [service],
    globalVariables: { global: ["private global"] },
  };
  const before = structuredClone({ project, environment });
  const [local, global] = planEnvironmentInspection(project, environment);
  assert.equal(local[0], "环境变量(3)");
  assert.equal(global[0], "全局变量(1)");
  assert.match(local[1], /&lt;Default service&gt;.*地址已配置/);
  assert.match(local[1], /count.*当前值已隐藏/);
  assert.match(local[1], /&lt;name&gt;.*仅有初始定义/);
  assert.match(global[1], /global.*当前值已隐藏/);
  assert.doesNotMatch(local[1] + global[1], /private/);
  assert.deepEqual({ project, environment }, before);
});

test("snapshot tabs only render an escaped allowlist of metadata, not copied request contents", () => {
  const [head, query, path, body, auth, cookie, scripts] = planStepInspection({
    headers: [
      {
        key: "<fixture>",
        value: "private headers",
        description: "private note",
      },
    ],
    query: [{ key: "view", value: "private query", enabled: false }],
    auth: { type: "bearer", token: "private auth" },
    bodyType: "json",
    body: "private body",
    cookies: [{ key: "session", value: "private cookie" }],
    beforeScript: "private script",
    url: "private url",
  });
  assert.match(head[1], /&lt;fixture&gt;.*值已隐藏/);
  assert.match(query[1], /view.*已禁用/);
  assert.match(path[1], /暂无路径参数/);
  assert.match(body[1], /json.*内容已隐藏/);
  assert.match(auth[1], /bearer.*不显示/);
  assert.match(cookie[1], /session.*值已隐藏/);
  assert.match(scripts[1], /发送前.*源码已隐藏.*发送后.*未记录源码/);
  assert.doesNotMatch(
    [head, query, path, body, auth, cookie, scripts].flat().join(" "),
    /private/,
  );
});

test("plan environment matches an explicit selection or current default, never a different environment on missing ID", () => {
  const plan = { id: "plan", steps: [] };
  const project = {
    plans: [plan],
    runs: [],
    currentEnvironmentId: "second",
    environments: [
      { id: "first", name: "First" },
      { id: "second", name: "Second" },
    ],
  };
  const render = () => renderPlans({ project, planId: plan.id });
  assert.match(render(), /<option value="second" selected>Second/);
  plan.environmentId = "first";
  assert.match(render(), /<option value="first" selected>First/);
  plan.environmentId = "missing";
  const missing = render();
  assert.match(missing, /<option value="" selected disabled>环境不可用/);
  assert.match(missing, /aria-controls="plan-environment-inspection" disabled/);
});
