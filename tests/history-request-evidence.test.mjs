import test from "node:test";
import assert from "node:assert/strict";
import { assertHistoryRequests } from "./helpers/history-request-evidence.mjs";
const endpoint = "http://127.0.0.1:12345/api/projects/fixture";
const save = { url: endpoint, method: "PUT" },
  read = { url: endpoint, method: "GET" };
const poll = { url: "http://127.0.0.1:12345/api/mcp/config", method: "GET" };
test("reproduces old exact-array false failure with real activity-poll shape", () => {
  const actual = [save, poll];
  assert.throws(() => assert.deepEqual(actual, [save]));
  assertHistoryRequests(actual, [save], endpoint);
});
test("poll may overlap before and after either single save or held GET", () => {
  for (const expected of [save, read])
    assertHistoryRequests([poll, expected, poll], [expected], endpoint);
});
for (const [label, unexpected] of [
  ["duplicate save", save],
  ["automatic project read", read],
  ["other project read", { url: endpoint + "-other", method: "GET" }],
  ["config write", { ...poll, method: "POST" }],
  ["config HEAD", { ...poll, method: "HEAD" }],
  ["query variant", { ...poll, url: poll.url + "?other=1" }],
  ["other origin", { ...poll, url: poll.url.replace("12345", "12346") }],
  ["business execution", { url: endpoint + "/run", method: "POST" }],
  ["business read", { url: "http://127.0.0.1:9000/login", method: "GET" }],
])
  test(`still rejects ${label}`, () => {
    assert.throws(() =>
      assertHistoryRequests([save, poll, unexpected], [save], endpoint),
    );
  });
test("missing expected write is never hidden by polls", () => {
  assert.throws(() => assertHistoryRequests([poll], [save], endpoint));
});
test("actual activity poll reads only config when visible and is scheduled independently", async () => {
  const { readFile } = await import("node:fs/promises");
  const vm = await import("node:vm");
  const source = await readFile(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function refreshMCPActivity()");
  const marker = "setInterval(refreshMCPActivity, 1000);";
  const end = source.indexOf(marker, start);
  assert(start > 0 && end > start);
  const calls = [],
    schedules = [];
  const context = vm.createContext({
    token: "synthetic",
    document: { hidden: false },
    mcpPollSequence: 0,
    mcpState: null,
    updateMCPPanel: null,
    $: () => null,
    api: async (...args) => {
      calls.push(args);
      return { activities: [] };
    },
    setInterval: (fn, interval) => schedules.push({ fn, interval }),
  });
  vm.runInContext(source.slice(start, end + marker.length), context);
  assert.equal(schedules.length, 1);
  assert.equal(schedules[0].interval, 1000);
  await schedules[0].fn();
  assert.deepEqual(calls, [["/mcp/config"]]);
  context.document.hidden = true;
  await schedules[0].fn();
  assert.equal(calls.length, 1);
});
