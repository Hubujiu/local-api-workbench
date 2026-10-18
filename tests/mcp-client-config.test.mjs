import test from "node:test";
import assert from "node:assert/strict";
import {
  clientConfiguration,
  mcpClients,
} from "../public/mcp-client-config.js";
test("MCP client configuration uses correct root structure and safely quoted TOML", () => {
  const settings = {
    endpoint: "http://127.0.0.1:4318/mcp",
    token: "fixture-only",
  };
  for (const client of mcpClients.filter((c) => c !== "Codex")) {
    const data = JSON.parse(clientConfiguration(client, settings)),
      server = (data.servers || data.mcpServers).localapi;
    assert.equal(server.url, settings.endpoint);
    assert.equal(server.headers.Authorization, "Bearer fixture-only");
  }
  const codex = clientConfiguration("Codex", settings);
  assert(codex.startsWith("[mcp_servers.localapi]"));
  assert(codex.includes("http_headers"));
  assert(
    clientConfiguration("Codex", { ...settings, token: 'a"b' }).includes(
      'a\\"b',
    ),
  );
});
