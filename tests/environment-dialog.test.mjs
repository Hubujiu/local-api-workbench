import test from "node:test";
import assert from "node:assert/strict";
import {
  cookieManagerHTML,
  environmentDialogShell,
  environmentDialogHTML,
  readEnvironmentJSON,
} from "../public/environment-dialog.js";
test("environment dialog retains current JSON types and rejects invalid maps", () => {
  const input = {
    text: "value",
    number: 2,
    bool: false,
    nested: { a: [1, null] },
  };
  assert.deepEqual(readEnvironmentJSON(JSON.stringify(input)), input);
  for (const value of [
    "[]",
    "null",
    "false",
    '{"__proto__":1}',
    '{"constructor":2}',
    "{",
  ])
    assert.throws(() => readEnvironmentJSON(value));
});
test("environment dialog renders actual environments and scoped service URLs without changing project", () => {
  const environment = {
    id: "test",
    name: '<img src=x onerror="x">',
    variables: { baseUrl: "https://example.test", count: 0 },
    variableDefinitions: { count: { initialValue: 9, description: "keep me" } },
    serverUrls: { service: "https://service.example.test" },
  };
  const project = {
    environments: [environment],
    servers: [{ id: "service", name: "API" }],
  };
  const before = JSON.stringify(project);
  const html = environmentDialogHTML(project, environment);
  assert.match(html, /data-env-open="test" aria-current="page"/);
  assert.match(html, /https:\/\/service.example.test/);
  assert.match(html, /id="edit-env-name"/);
  assert.match(html, /id="modal-json"/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img/);
  assert.equal(JSON.stringify(project), before);
});
test("new environment preserves established baseUrl default and exposes no fake shared service", () => {
  const html = environmentDialogHTML({
    environments: [{ id: "dev", name: "开发" }],
  });
  assert.match(html, /http:\/\/localhost:8080/);
  assert.match(html, /暂无共享服务/);
  assert.match(html, /id="env-name"/);
  assert.match(html, /data-env-current/);
  assert.match(html, /role="alert"/);
});

test("toolbar cookie and selected environment panes share navigation without inventing environment actions", () => {
  const env = { id: "default", name: "默认环境", variables: {} };
  const project = { environments: [env] };
  const shell = environmentDialogShell(project, {
    workspace: true,
    section: "cookies",
    content: cookieManagerHTML(
      { enabled: false, cookies: [] },
      { workspace: true },
    ),
  });
  assert.match(
    shell,
    /environment-dialog--workspace environment-dialog--cookies/,
  );
  assert.match(shell, /data-env-section="cookies" aria-current="page"/);
  assert.doesNotMatch(shell, /data-env-open="default" aria-current/);
  assert.match(shell, /暂无 Cookie/);
  assert.match(shell, /状态：[\s\S]*已关闭/);
  assert.match(shell, /立即生效，关闭窗口不撤销/);
  assert.match(shell, /id="cookie-line" type="password"/);
  assert.match(shell, /id="cookie-toggle"/);
  assert.doesNotMatch(shell, /添加域名|data-cookie-edit/);
  const selected = environmentDialogHTML(project, env, { workspace: true });
  assert.match(selected, /data-env-open="default" aria-current="page"/);
  assert.doesNotMatch(selected, /data-env-section="cookies" aria-current/);
});

test("real Cookie table and its immediate controls are available; no visible value markup", () => {
  const state = {
    enabled: true,
    cookies: [
      {
        key: "<img>",
        value: '<svg onload="bad">',
        domain: "example.invalid",
        path: "/",
      },
    ],
  };
  const shell = cookieManagerHTML(state, { workspace: true });
  assert.match(shell, /关闭自动Cookie/);
  assert.match(shell, /data-cookie-edit="0"/);
  assert.match(shell, /data-cookie-remove="0"/);
  assert.match(shell, /type="password" readonly value="&lt;svg/);
  assert.doesNotMatch(shell, /<img|<svg|暂无 Cookie/);
  assert.match(cookieManagerHTML(state), /textarea id="cookie-line"/);
});
