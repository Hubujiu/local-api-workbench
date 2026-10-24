export const mcpClients = [
  "Cursor",
  "Codex",
  "Claude Code",
  "VS Code",
  "WorkBuddy",
  "Trae",
];
export function clientConfiguration(client, { endpoint, token }) {
  const headers = { Authorization: "Bearer " + token };
  if (client === "Codex")
    return (
      "[mcp_servers.localapi]\nurl = " +
      JSON.stringify(endpoint) +
      "\nhttp_headers = { Authorization = " +
      JSON.stringify(headers.Authorization) +
      " }\n"
    );
  if (client === "VS Code")
    return JSON.stringify(
      { servers: { localapi: { type: "http", url: endpoint, headers } } },
      null,
      2,
    );
  const declaration = { url: endpoint, headers };
  if (["Claude Code", "WorkBuddy"].includes(client)) declaration.type = "http";
  return JSON.stringify({ mcpServers: { localapi: declaration } }, null, 2);
}
