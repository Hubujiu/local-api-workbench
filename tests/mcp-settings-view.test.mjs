import test from "node:test";
import assert from "node:assert/strict";
import {
  mcpSettingsPanel,
  mcpStatusMarkup,
} from "../public/mcp-settings-view.js";

test("MCP settings expose status and grants but never render the connection secret by default", () => {
  const config = {
    enabled: true,
    write: true,
    execute: false,
    remember: false,
    projects: ["p"],
    token: "never-render-this-secret",
    endpoint: "http://127.0.0.1:9000/mcp",
  };
  const html = mcpSettingsPanel(
    { id: "p" },
    [{ id: "p", name: "<unsafe>" }],
    config,
  );
  assert(!html.includes(config.token));
  assert(!html.includes("<unsafe>"));
  assert(html.includes("&lt;unsafe&gt;"));
  assert.equal((html.match(/data-mcp-preview-client=/g) || []).length, 6);
  assert(html.includes('id="mcp-config"'));
  assert(html.includes('id="mcp-reveal-config"'));
  assert(html.includes('id="mcp-copy-config" disabled'));
  assert(html.includes("只在本机"));
});

test("MCP settings distinguish unknown and disabled state without invented connection history", () => {
  assert(mcpStatusMarkup({}, []).includes("读取中"));
  const html = mcpStatusMarkup(
    { enabled: false, projects: [], lastActivity: null },
    [],
  );
  assert(html.includes("已关闭"));
  assert(html.includes("暂无连接记录"));
  assert(html.includes("尚未授权项目"));
});

test("MCP preview hides revoked keys and interrupted copies cannot leak an old configuration", async () => {
  const { bindMCPSettings } = await import("../public/mcp-settings-view.js");
  const nodes = new Map();
  const root = {
    isConnected: true,
    querySelector(selector) {
      if (!nodes.has(selector))
        nodes.set(selector, {
          textContent: "",
          innerHTML: "",
          disabled: false,
        });
      return nodes.get(selector);
    },
    querySelectorAll() {
      return [];
    },
  };
  const config = {
    enabled: true,
    projects: [],
    endpoint: "http://127.0.0.1:9000/mcp",
    token: "first-test-key",
  };
  let load = async () => config;
  const copies = [];
  const update = bindMCPSettings(root, {
    projects: [],
    initial: config,
    loadConfig: () => load(),
    copy: async (value) => copies.push(value),
  });
  const reveal = root.querySelector("#mcp-reveal-config"),
    copy = root.querySelector("#mcp-copy-config"),
    code = root.querySelector("#mcp-inline-code");
  await reveal.onclick();
  assert(code.textContent.includes(config.token));
  let resolve;
  load = () =>
    new Promise((r) => {
      resolve = r;
    });
  const copying = copy.onclick();
  await reveal.onclick();
  resolve(config);
  await copying;
  assert.equal(copies.length, 0);
  assert(!code.textContent.includes(config.token));
  load = async () => config;
  await reveal.onclick();
  assert.equal(copy.disabled, false);
  update({ ...config, enabled: false, token: "" });
  assert(!code.textContent.includes(config.token));
  assert.equal(copy.disabled, true);
  assert.equal(reveal.disabled, true);
  update(config);
  assert.equal(reveal.disabled, false);
  load = () =>
    new Promise((r) => {
      resolve = r;
    });
  const showing = reveal.onclick();
  root.isConnected = false;
  resolve(config);
  await showing;
  assert(!code.textContent.includes(config.token));
});

test("MCP last activity reads the actual server activity object", () => {
  const html = mcpStatusMarkup(
    {
      enabled: true,
      projects: [],
      lastActivity: { finishedAt: "2026-10-22T06:00:00Z", status: "completed" },
    },
    [],
  );
  assert(!html.includes("暂无连接记录"));
  assert(html.includes("2026"));
});
