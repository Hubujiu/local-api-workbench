import assert from "node:assert/strict";
// The real visible UI polls MCP activity every second independently of save,
// refresh or render. Exempt only that exact owner-origin GET, never arbitrary
// reads, config writes, query variants, cross-origin traffic or duplicate PUTs.
export function assertHistoryRequests(actual, expected, projectEndpoint) {
  const activityURL = new URL("/api/mcp/config", projectEndpoint).href;
  const observed = actual.filter(
    (request) => !(request.method === "GET" && request.url === activityURL),
  );
  assert.deepEqual(observed, expected);
}
