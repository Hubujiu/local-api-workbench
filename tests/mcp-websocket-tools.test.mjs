import test from "node:test";
import assert from "node:assert/strict";
import { createMCP } from "../src/mcp.mjs";

const cases = [
  [
    "start_websocket_session",
    "start",
    { definitionId: "d", operationId: "start-1" },
  ],
  ["get_websocket_session", "get", { sessionId: "s" }],
  [
    "send_websocket_session",
    "send",
    { sessionId: "s", operationId: "send-1", message: "hello" },
  ],
  ["stop_websocket_session", "stop", { sessionId: "s" }],
  ["renew_websocket_session", "renew", { sessionId: "s" }],
  ["get_websocket_operation", "operation", { operationId: "send-1" }],
];
const owner = Object.freeze({});
const message = (name, args) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: `localapi_${name}`, arguments: args },
});
function setup(options = {}) {
  const calls = [];
  const service = {
    call: async (...args) => {
      calls.push(args);
      return { state: "pending", example: "receipt" };
    },
  };
  const dispatch = createMCP({
    store: {
      get: () => {
        throw Error(
          "adapter must not asynchronously read before reserving operation",
        );
      },
    },
    projects: ["p"],
    write: true,
    execute: true,
    websocketSessions: service,
    ...options,
  });
  return { dispatch, calls };
}
async function tools(dispatch) {
  return (await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/list" }))
    .result.tools;
}
function rejected(response) {
  assert.equal(response.result.isError, true, JSON.stringify(response));
}

test("HTTP websocket adapters advertise only with service and both grants", async () => {
  const { dispatch } = setup();
  const available = await tools(dispatch);
  for (const [name] of cases) {
    const tool = available.find((t) => t.name === `localapi_${name}`);
    assert.ok(tool);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  for (const options of [
    { websocketSessions: undefined },
    { write: false },
    { execute: false },
  ]) {
    const { dispatch, calls } = setup(options);
    const names = (await tools(dispatch)).map((t) => t.name);
    for (const [name, , input] of cases) {
      assert.equal(names.includes(`localapi_${name}`), false);
      rejected(
        await dispatch(message(name, { projectId: "p", ...input }), {
          websocketOwner: owner,
        }),
      );
    }
    assert.equal(calls.length, 0);
  }
});

test("HTTP websocket adapters pass only host ownership and validated exact arguments", async () => {
  const { dispatch, calls } = setup();
  for (const [name, action, input] of cases) {
    const args = { projectId: "p", ...input };
    const result = await dispatch(message(name, args), {
      websocketOwner: owner,
    });
    assert.notEqual(result.result.isError, true);
    assert.deepEqual(JSON.parse(result.result.content[0].text), {
      state: "pending",
      example: "receipt",
    });
    const call = calls.at(-1);
    assert.equal(call[0], action);
    assert.equal(call[1], owner);
    assert.deepEqual(call[2], args);
  }
  assert.equal(calls.length, 6);
});

test("HTTP websocket adapters reject stateless, foreign project, missing and forged arguments without service calls", async () => {
  const { dispatch, calls } = setup();
  for (const [name, , input] of cases) {
    const args = { projectId: "p", ...input };
    rejected(await dispatch(message(name, args)));
    rejected(
      await dispatch(message(name, args), { websocketOwner: "client-id" }),
    );
    rejected(
      await dispatch(message(name, { ...args, projectId: "other" }), {
        websocketOwner: owner,
      }),
    );
    for (const key of Object.keys(args)) {
      const missing = { ...args };
      delete missing[key];
      rejected(
        await dispatch(message(name, missing), { websocketOwner: owner }),
      );
    }
    for (const [key, value] of Object.entries({
      owner: {},
      websocketOwner: {},
      url: "ws://127.0.0.1",
      headers: {},
      type: "grpc",
      epoch: 0,
    }))
      rejected(
        await dispatch(message(name, { ...args, [key]: value }), {
          websocketOwner: owner,
        }),
      );
  }
  rejected(
    await dispatch(
      message("send_websocket_session", {
        projectId: "p",
        sessionId: "s",
        operationId: "o",
        message: { text: "not-string" },
      }),
      { websocketOwner: owner },
    ),
  );
  assert.equal(calls.length, 0);
});

test("HTTP websocket read pagination is explicitly bounded and never substituted for renew", async () => {
  const { dispatch, calls } = setup();
  for (const invalid of [
    { afterEvent: -1 },
    { afterEvent: 1.2 },
    { afterEvent: Number.MAX_SAFE_INTEGER + 1 },
    { afterEvent: "0" },
    { limit: 0 },
    { limit: 21 },
    { limit: 1.5 },
    { limit: "1" },
  ])
    rejected(
      await dispatch(
        message("get_websocket_session", {
          projectId: "p",
          sessionId: "s",
          ...invalid,
        }),
        { websocketOwner: owner },
      ),
    );
  assert.equal(calls.length, 0);
  await dispatch(
    message("get_websocket_session", {
      projectId: "p",
      sessionId: "s",
      afterEvent: 0,
      limit: 20,
    }),
    { websocketOwner: owner },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "get");
  assert.deepEqual(calls[0][2], {
    projectId: "p",
    sessionId: "s",
    afterEvent: 0,
    limit: 20,
  });
});

test("WebSocket start/send failed or unknown receipts remain visible as MCP errors, while operation queries are successful reads", async () => {
  for (const state of [
    "failed-before-submit",
    "unknown",
    "pending",
    "started",
    "locally-written",
  ]) {
    const receipt = {
      operationId: "o",
      state,
      retrySafe: false,
      remoteConfirmed: false,
    };
    const { dispatch } = setup({
      websocketSessions: { call: async () => receipt },
    });
    for (const [name, action, input] of cases.filter(([, action]) =>
      ["start", "send", "operation"].includes(action),
    )) {
      const response = await dispatch(
        message(name, { projectId: "p", ...input }),
        { websocketOwner: owner },
      );
      assert.equal(
        response.result.isError === true,
        action !== "operation" &&
          ["failed-before-submit", "unknown"].includes(state),
      );
      assert.deepEqual(JSON.parse(response.result.content[0].text), receipt);
    }
  }
});
