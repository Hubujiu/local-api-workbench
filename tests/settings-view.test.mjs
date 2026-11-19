import test from "node:test";
import assert from "node:assert/strict";
import { settingsPanel } from "../public/settings-view.js";
import { settingsSidebar } from "../public/resource-view.js";
test("settings navigation renders only the selected configuration pane with escaped project data", () => {
  const project = {
    id: "project",
    name: "<unsafe>",
    environments: [{ id: "env", name: "QA", variables: {} }],
    settings: {},
  };
  const basic = settingsPanel(project, "settings-basic");
  assert(basic.includes('id="project-name"'));
  assert(!basic.includes('id="mcp-config"'));
  assert(!basic.includes("<unsafe>"));
  const mcp = settingsPanel(project, "settings-mcp");
  assert(mcp.includes('id="mcp-config"'));
  assert(!mcp.includes('id="project-name"'));
  const env = settingsPanel(project, "settings-environments");
  assert(env.includes('data-debug-env="env"'));
  assert(
    settingsSidebar("settings-mcp").includes(
      'data-settings-anchor="settings-mcp" class="active" aria-current="page"',
    ),
  );
});

test("basic settings retain editable name and explicit actions in the scoped visual page", () => {
  const html = settingsPanel({ id: "p", name: 'A" <B>', settings: {} });
  assert(html.includes("settings-basic-page"));
  assert(html.includes('for="project-name"'));
  assert(html.includes('value="A&quot; &lt;B&gt;"'));
  for (const id of ["project-name", "save", "archive-project"])
    assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1);
  assert(html.includes("导出或 Git 提交前请移除秘密"));
  assert(!html.includes("Apipost"));
});

test("MCP visual scope leaves other settings unchanged and retains closed access controls", () => {
  const project = { id: "p", name: "Local", settings: {}, environments: [] };
  const html = settingsPanel(project, "settings-mcp", "", {
    enabled: false,
    projects: [],
    token: "hidden-test-secret",
  });
  assert(html.includes("settings-mcp-page"));
  assert(html.includes('id="mcp-reveal-config" disabled'));
  assert(html.includes('id="mcp-copy-config" disabled'));
  assert(html.includes('id="mcp-config"'));
  assert(html.includes("关闭服务会撤销当前令牌"));
  assert(!html.includes("hidden-test-secret"));
  for (const page of ["settings-environments", "settings-mock"])
    assert(!/settings-(basic|mcp)-page/.test(settingsPanel(project, page)));
});

test("compact settings navigation retains every destination and separate connection and transfer groups", () => {
  const html = settingsSidebar("settings-mcp");
  assert.equal((html.match(/data-settings-anchor=/g) || []).length, 11);
  for (const label of [
    "环境与服务",
    "全局请求参数",
    "参数说明库",
    "数据库连接",
    "导入项目（手动）",
    "导出项目",
  ])
    assert(html.includes(label));
  assert(html.includes("<strong>连接</strong>"));
  assert(html.includes("<strong>导入 / 导出</strong>"));
});
