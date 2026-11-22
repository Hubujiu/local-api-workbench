import assert from "node:assert/strict";
import test from "node:test";
import {
  mcpTopStatus,
  mcpTopStatusButton,
  updateMCPTopStatus,
} from "../public/mcp-top-status.js";

test("loading, off, enabled, failed and shared activities are different truthful statuses", () => {
  const off = { enabled: false, activities: [] };
  assert.equal(mcpTopStatus(null).kind, "loading");
  assert.deepEqual(mcpTopStatus(off), { kind: "off", text: "MCP · 未开启" });
  assert.equal(mcpTopStatus({ ...off, enabled: true }).kind, "enabled");
  assert.equal(
    mcpTopStatus({ ...off, enabled: true }, true).kind,
    "unavailable",
  );
  assert.deepEqual(
    mcpTopStatus({
      ...off,
      activities: [{ status: "running" }, { status: "done" }],
    }),
    {
      kind: "running",
      text: "MCP · 1 个任务运行中",
    },
  );
});

test("unchanged status is not reannounced; markup and updates never copy credential fields", () => {
  const off = {
    enabled: false,
    activities: [],
    token: "synthetic-secret-never-render",
  };
  assert.doesNotMatch(
    mcpTopStatusButton(off),
    /synthetic-secret-never-render|role="switch"/,
  );
  assert.match(
    mcpTopStatusButton(off),
    /data-settings-target="settings-mcp".*role="status" aria-live="polite"/,
  );
  const updates = [];
  const label = {
    _content: "MCP · 未开启",
    get textContent() {
      return this._content;
    },
    set textContent(value) {
      updates.push(value);
      this._content = value;
    },
  };
  const announcer = { textContent: "" };
  const button = {
    dataset: { mcpState: "off" },
    querySelector: () => label,
    parentElement: { querySelector: () => announcer },
  };
  updateMCPTopStatus(button, off, false);
  updateMCPTopStatus(button, off, true);
  updateMCPTopStatus(button, off, true);
  assert.equal(button.dataset.mcpState, "unavailable");
  assert.deepEqual(updates, ["MCP · 状态不可用"]);
  assert.equal(announcer.textContent, "MCP · 状态不可用");
});
