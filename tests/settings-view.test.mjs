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
