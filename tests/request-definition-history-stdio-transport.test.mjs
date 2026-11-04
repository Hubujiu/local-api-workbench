import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { serveMCPStdio } from "../src/mcp-stdio.mjs";

const mutations = [
  "localapi_tag_api_definition_version",
  "localapi_restore_api_definition",
  "localapi_clear_api_definition_history",
];
const frame = (value) => JSON.stringify(value) + "\n";
const call = (id, name) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: {} },
});
const result = (id, value = {}) => ({
  jsonrpc: "2.0",
  id,
  result: { content: [{ type: "text", text: JSON.stringify(value) }] },
});
const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (predicate()) return;
    await delay(5);
  }
  throw Error("Definition history transport observation timed out");
};

test(
  "stdio history mutations are cancellable without execution activity or evidence",
  { timeout: 10000 },
  async () => {
    const input = new PassThrough(),
      output = new PassThrough();
    const signals = new Map(),
      frames = [],
      activities = [];
    let bytes = "";
    output.on("data", (chunk) => {
      bytes += chunk;
    });
    const serving = serveMCPStdio({
      input,
      output,
      dispatch: async (message, { signal, onProgress }) => {
        signals.set(message.id, signal);
        if (message.id === "read") return result(message.id);
        assert(signal instanceof AbortSignal);
        await onProgress({ status: "failed", recordSaved: false });
        if (!signal.aborted)
          await new Promise((resolve) =>
            signal.addEventListener("abort", resolve, { once: true }),
          );
        frames.push(message.id);
        return result(message.id, { status: "failed", recordSaved: false });
      },
      activityFactory(message) {
        activities.push(message.params.name);
        return { start() {}, update() {}, finish() {} };
      },
    });
    for (const [index, name] of mutations.entries())
      input.write(frame(call(index, name)));
    input.write(frame(call("read", "localapi_list_api_definition_history")));
    await waitFor(() => signals.size === 4);
    assert.equal(signals.get("read"), undefined);
    input.write(
      frame({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 0 },
      }),
    );
    await waitFor(() => frames.includes(0));
    assert.equal(signals.get(1).aborted, false);
    assert.equal(signals.get(2).aborted, false);
    input.end();
    await serving;
    assert.deepEqual(activities, []);
    assert.equal(signals.get(1).aborted, true);
    assert.equal(signals.get(2).aborted, true);
    const replies = bytes.trim().split("\n").filter(Boolean).map(JSON.parse);
    assert(
      !replies.some((item) => item.id === 0),
      "cancelled mutation must suppress its late reply",
    );
    assert(replies.some((item) => item.id === "read"));
  },
);

test(
  "history mutation and execution tools retain distinct stdio activity semantics",
  { timeout: 10000 },
  async () => {
    const input = new PassThrough(),
      output = new PassThrough();
    output.resume();
    const activity = [],
      seen = [];
    const serving = serveMCPStdio({
      input,
      output,
      dispatch: async (message, { signal }) => {
        assert(signal instanceof AbortSignal);
        seen.push(message.id);
        return result(message.id, { status: "passed", recordSaved: true });
      },
      activityFactory(message) {
        activity.push(["created", message.params.name]);
        return {
          start() {
            activity.push(["started"]);
          },
          finish(error, outcome) {
            activity.push(["finished", error, outcome]);
          },
        };
      },
    });
    input.write(
      frame(call(0, mutations[0])) + frame(call(1, "localapi_execute_api")),
    );
    await waitFor(
      () => seen.length === 2 && activity.some((row) => row[0] === "finished"),
    );
    input.end();
    await serving;
    assert.deepEqual(activity, [
      ["created", "localapi_execute_api"],
      ["started"],
      ["finished", false, { status: "passed", recordSaved: true }],
    ]);
  },
);
