import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  observeToolCall,
  toolCallFailureDiagnostic,
} from "./helpers/mcp-cancellation-observation.mjs";

// Pure Promise fixtures: never import the application, a worker, or a database.
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const cancelAfterHandshake = async (pending, controller, handshake) => {
  const observation = observeToolCall(pending);
  try {
    await handshake(observation.assertPending);
    observation.assertPending();
    controller.abort();
    await assert.rejects(async () => {
      const terminal = await observation.completion;
      if (terminal.kind === "rejected") throw terminal.reason;
      return terminal.value;
    }, /abort|cancel/i);
  } finally {
    controller.abort();
  }
};

for (const kind of ["fulfilled", "rejected"]) {
  test(`an early ${kind} call is handled immediately but never counts as cancellation`, async () => {
    const call = deferred();
    const observation = observeToolCall(call.promise);
    const value =
      kind === "fulfilled" ? { status: "cancelled" } : Error("cancelled early");
    call[kind === "fulfilled" ? "resolve" : "reject"](value);
    await nextTurn();
    const terminal = await observation.completion;
    assert.equal(terminal.kind, kind);
    assert.equal(terminal[kind === "fulfilled" ? "value" : "reason"], value);
    assert.throws(observation.assertPending, /before fixture abort/);
  });
}

test("handshake then abort still requires the original SDK cancellation rejection", async () => {
  const controller = new AbortController();
  const call = deferred();
  let handshakes = 0;
  controller.signal.addEventListener("abort", () => {
    assert.equal(handshakes, 1);
    call.reject(new DOMException("This operation was aborted", "AbortError"));
  });
  await cancelAfterHandshake(
    call.promise,
    controller,
    async (assertPending) => {
      assertPending();
      handshakes++;
    },
  );
  assert.equal(controller.signal.aborted, true);
});

test("a result arriving in the handshake continuation window still fails before abort", async () => {
  const controller = new AbortController();
  const call = deferred();
  await assert.rejects(
    cancelAfterHandshake(call.promise, controller, async (assertPending) => {
      assertPending();
      call.resolve({ status: "failed" });
    }),
    /before fixture abort/,
  );
  assert.equal(controller.signal.aborted, true);
});

test("resolving on abort is a failure, not a successful cancellation", async () => {
  const controller = new AbortController();
  const call = deferred();
  controller.signal.addEventListener("abort", () =>
    call.resolve({ status: "cancelled" }),
  );
  await assert.rejects(
    cancelAfterHandshake(call.promise, controller, async (assertPending) =>
      assertPending(),
    ),
    /Missing expected rejection/,
  );
});

test("a non-cancellation rejection after abort remains a failed assertion", async () => {
  const controller = new AbortController();
  const call = deferred();
  controller.signal.addEventListener("abort", () =>
    call.reject(Error("unrelated failure")),
  );
  await assert.rejects(
    cancelAfterHandshake(call.promise, controller, async (assertPending) =>
      assertPending(),
    ),
    { code: "ERR_ASSERTION" },
  );
});

test("handshake failure aborts cleanup and observes its later rejection without masking the failure", async () => {
  const controller = new AbortController();
  const call = deferred();
  const failure = Error("handshake observation failed");
  controller.signal.addEventListener("abort", () =>
    call.reject(Error("cancelled during cleanup")),
  );
  await assert.rejects(
    cancelAfterHandshake(call.promise, controller, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  await nextTurn();
  assert.equal(controller.signal.aborted, true);
});

test("early rejection stays handled across an event-loop turn while the handshake is pending", async () => {
  const controller = new AbortController();
  const call = deferred();
  const handshake = deferred();
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    const running = cancelAfterHandshake(
      call.promise,
      controller,
      async () => handshake.promise,
    );
    const rejected = assert.rejects(running, /before fixture abort/);
    call.reject(Error("cancelled before handshake"));
    await nextTurn();
    assert.deepEqual(unhandled, []);
    handshake.resolve();
    await rejected;
    await nextTurn();
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    controller.abort();
  }
});

const prefix = "MCP_CANCELLATION_METADATA ";
const diagnostic = (name, terminal) => {
  const text = toolCallFailureDiagnostic(name, terminal);
  assert(text.startsWith(prefix));
  assert(Buffer.byteLength(text) <= 4096);
  return { text, metadata: JSON.parse(text.slice(prefix.length)) };
};
const fulfilled = (text, extra = {}) => ({
  kind: "fulfilled",
  value: { content: [{ type: "text", text }], ...extra },
});

test("canonical diagnostics reuse only bounded CLI script metadata", () => {
  const secret = "SECRET /private/path bearer credential";
  const { text, metadata } = diagnostic(
    "localapi_execute_api",
    fulfilled(
      JSON.stringify({
        status: "failed",
        variables: { token: secret },
        results: [
          {
            status: "failed",
            error: secret,
            scriptStage: "total-deadline",
            scriptDiagnostics: {
              elapsedMs: 2001,
              lastWorkerStage: "loading-libraries",
              private: secret,
            },
          },
        ],
      }),
      { isError: false, private: secret },
    ),
  );
  assert.equal(metadata.terminalKind, "fulfilled");
  assert.equal(metadata.result.status, "failed");
  assert.equal(metadata.result.steps[0].scriptStage, "total-deadline");
  assert.equal(metadata.result.steps[0].elapsedMs, 2001);
  assert(!text.includes(secret));
});

test("native summaries expose only fixed status, isError, and terminal kind without invented script diagnostics", () => {
  for (const name of ["apipost_execute_api", "apipost_execute_flow"]) {
    const { text, metadata } = diagnostic(
      name,
      fulfilled(
        JSON.stringify({
          status: "failed",
          failed: [{ error: "SECRET raw error" }],
          results: [{ scriptStage: "bootstrap" }],
        }),
        { isError: true },
      ),
    );
    assert.deepEqual(metadata, {
      terminalKind: "fulfilled",
      isError: true,
      status: "failed",
    });
    assert(!text.includes("SECRET"));
    assert(!text.includes("bootstrap"));
  }
});

test("rejection diagnostics omit raw errors, messages, stacks and arbitrary fields", () => {
  const reason = Object.assign(Error("SECRET raw error"), {
    scriptStage: "bootstrap",
    token: "SECRET credential",
  });
  const { text, metadata } = diagnostic("localapi_execute_flow", {
    kind: "rejected",
    reason,
  });
  assert.equal(metadata.rejection.scriptStage, "bootstrap");
  assert(!text.includes("SECRET"));
  assert.deepEqual(
    diagnostic("apipost_execute_flow", { kind: "rejected", reason }).metadata,
    { terminalKind: "rejected" },
  );
});

test("diagnostics never invoke getters, proxy traps, coercion or toJSON", () => {
  let calls = 0;
  const trap = () => {
    calls++;
    throw Error("SECRET diagnostic trap");
  };
  const proxy = new Proxy({}, { get: trap, getOwnPropertyDescriptor: trap });
  const getterEnvelope = {};
  for (const key of ["content", "isError", "toJSON"])
    Object.defineProperty(getterEnvelope, key, { get: trap });
  const textObject = { toString: trap, toJSON: trap, valueOf: trap };
  const getterBlock = {};
  for (const key of ["type", "text"])
    Object.defineProperty(getterBlock, key, { get: trap });
  const getterArray = [];
  Object.defineProperty(getterArray, "0", { get: trap });
  for (const value of [
    proxy,
    getterEnvelope,
    { content: proxy },
    { content: getterArray },
    { content: [getterBlock] },
    { content: [{ type: "text", text: textObject }] },
  ]) {
    for (const name of ["localapi_execute_api", "apipost_execute_api"])
      assert(
        !diagnostic(name, { kind: "fulfilled", value }).text.includes("SECRET"),
      );
  }
  diagnostic("localapi_execute_api", { kind: "rejected", reason: proxy });
  assert.equal(calls, 0);
});

test("oversized, malformed and unknown-status text stays bounded and undisclosed", () => {
  for (const text of [
    "SECRET invalid JSON",
    "SECRET".repeat(400000),
    "界".repeat(800000),
    '{"status":"SECRET unknown status"}',
  ]) {
    for (const name of ["localapi_execute_flow", "apipost_execute_flow"]) {
      const result = diagnostic(name, fulfilled(text));
      assert(!result.text.includes("SECRET"));
      if (name.startsWith("apipost_"))
        assert.equal(result.metadata.status, "unknown");
    }
  }
});
