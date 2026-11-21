import test from "node:test";
import assert from "node:assert/strict";
import {
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
