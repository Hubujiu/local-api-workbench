import test from "node:test";
import assert from "node:assert/strict";
import {
  createGrpcStreamState,
  createGrpcStreamController,
  invalidateGrpcStream,
  renderGrpcStream,
  bindGrpcStream,
} from "../public/grpc-stream-workbench.js";
const view = (more = {}) => ({
  id: "s1",
  type: "grpc",
  definitionId: "d1",
  lifecycle: "active",
  requestState: "writable",
  streaming: { request: true, response: true },
  messages: [],
  requestMessages: [],
  recordSaved: false,
  receiptState: null,
  ...more,
});
function setup(overrides = {}) {
  const state = createGrpcStreamState();
  state.definitionId = "d1";
  const calls = [],
    busy = [];
  let persisted;
  const options = {
    state,
    definitions: [{ id: "d1", name: "stream", service: "S", method: "M" }],
    assertCurrent() {},
    inspectDefinition: async () => ({
      services: [
        {
          name: "S",
          methods: [
            {
              name: "M",
              requestStream: !state.initialEnabled,
              responseStream: true,
            },
          ],
        },
      ],
    }),
    setBusy(x, k) {
      busy.push([x, k]);
    },
    post: async (path, body) => {
      calls.push([path, body]);
      return view();
    },
    get: async (path) => {
      calls.push([path]);
      return view();
    },
    persistEvidence(s) {
      persisted = structuredClone({
        sessionId: s.sessionId,
        uncertainStart: s.uncertainStart,
        uncertainSessions: s.uncertainSessions,
        persistenceProblems: s.persistenceProblems,
      });
      return true;
    },
    ...overrides,
  };
  return {
    state,
    calls,
    busy,
    options,
    c: createGrpcStreamController(options),
    persisted: () => persisted,
  };
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
test("start uses saved definition, optional server initial, transient credentials", async () => {
  const x = setup();
  x.state.metadata = '[{"key":"auth","value":"secret"}]';
  x.state.key = "private";
  x.state.initialEnabled = true;
  x.state.initialMessage = '{"n":1}';
  await x.c.start();
  assert.equal(x.calls[0][0], "grpc-sessions");
  assert.deepEqual(x.calls[0][1].message, { n: 1 });
  assert.equal(x.calls[0][1].tls.key, "private");
  assert.equal(x.state.sessionId, "s1");
  assert.equal(x.state.uncertainStart, false);
  assert.ok(!JSON.stringify(x.persisted()).includes("secret"));
});
test("client creation omits initial message unless explicitly enabled", async () => {
  const x = setup();
  await x.c.start();
  assert.equal(Object.hasOwn(x.calls[0][1], "message"), false);
});
test("unknown definition and malformed metadata fail before submission", async () => {
  const x = setup();
  x.state.definitionId = "none";
  await assert.rejects(x.c.start(), /请选择/);
  x.state.definitionId = "d1";
  x.state.metadata = "{}";
  await assert.rejects(x.c.start(), /JSON数组/);
  assert.equal(x.calls.length, 0);
});
test("missing recovery persistence refuses start", async () => {
  const x = setup({ persistEvidence: () => false });
  await x.c.start();
  assert.equal(x.calls.length, 0);
  assert.equal(x.state.uncertainStart, true);
  await assert.rejects(x.c.start(), /未确认/);
});
test("lost start never repeats", async () => {
  let n = 0;
  const x = setup({
    post: async () => {
      n++;
      throw Error("lost");
    },
  });
  await x.c.start();
  await assert.rejects(x.c.start(), /未确认/);
  assert.equal(n, 1);
});
test("double start cannot dispatch twice", async () => {
  const d = deferred();
  let n = 0;
  const x = setup({
    post: () => {
      n++;
      return d.promise;
    },
  });
  const p = x.c.start();
  await assert.rejects(x.c.start());
  d.resolve(view());
  await p;
  assert.equal(n, 1);
});
test("late start retained without automatic adoption", async () => {
  const d = deferred();
  const x = setup({ post: () => d.promise });
  const p = x.c.start();
  await new Promise((resolve) => setImmediate(resolve));
  invalidateGrpcStream(x.state);
  d.resolve(view());
  await p;
  assert.equal(x.state.session, null);
  assert.equal(x.state.lateResult.id, "s1");
  assert.equal(x.state.uncertainStart, true);
});
test("invalidation clears runtime credentials", () => {
  const x = setup();
  x.state.metadata = "secret";
  x.state.key = "secret";
  invalidateGrpcStream(x.state);
  assert.equal(x.state.metadata, "[]");
  assert.equal(x.state.key, "");
});
test("send only explicit, local pending requires refresh before next send", async () => {
  const x = setup({
    post: async () => view({ requestMessages: [{ sendState: "pending" }] }),
  });
  x.state.session = view();
  x.state.sessionId = "s1";
  await x.c.send();
  assert.equal(x.state.uncertainSessions.length, 0);
  await assert.rejects(x.c.send(), /drain/);
});
test("lost send remains unknown after successful read and refuses replay", async () => {
  let n = 0;
  const x = setup({
    post: async () => {
      n++;
      throw Error("lost");
    },
  });
  x.state.session = view();
  x.state.sessionId = "s1";
  await x.c.send();
  await x.c.poll();
  await assert.rejects(x.c.send(), /未知/);
  await assert.rejects(x.c.halfClose(), /未知/);
  assert.equal(n, 1);
  assert.deepEqual(x.state.uncertainSessions, ["s1"]);
  assert.match(renderGrpcStream(x.state), /id="grpc-stream-send"[^>]*disabled/);
});
test("halfclose sends no message and preserves response wait semantics", async () => {
  const x = setup({
    post: async (path, body) => {
      assert.equal(path, "grpc-sessions/s1/half-close");
      assert.deepEqual(body, {});
      return view({ requestState: "halfClosing" });
    },
  });
  x.state.session = view();
  x.state.sessionId = "s1";
  await x.c.halfClose();
  assert.equal(x.state.session.requestState, "halfClosing");
  await assert.rejects(x.c.send(), /不可写/);
  assert.match(x.state.notice, /不代表RPC成功/);
});
test("terminal bad recording blocks new operations; read preserves unknown send", async () => {
  const x = setup({
    get: async () => view({ lifecycle: "terminal", receiptState: "failed" }),
  });
  x.state.sessionId = "s1";
  x.state.uncertainSessions = ["s1"];
  await x.c.poll();
  assert.deepEqual(x.state.persistenceProblems, ["s1"]);
  await assert.rejects(x.c.start(), /未确认/);
  assert.deepEqual(x.state.uncertainSessions, ["s1"]);
});
test("reconcile only terminal, explicit successful receipt clears storage issue not business unknown", async () => {
  const x = setup({
    post: async () =>
      view({ lifecycle: "terminal", receiptState: "saved", recordSaved: true }),
  });
  x.state.session = view();
  x.state.sessionId = "s1";
  await assert.rejects(x.c.reconcile(), /终态/);
  x.state.session.lifecycle = "terminal";
  x.state.persistenceProblems = ["s1"];
  x.state.uncertainSessions = ["s1"];
  await x.c.reconcile();
  assert.deepEqual(x.state.persistenceProblems, []);
  assert.deepEqual(x.state.uncertainSessions, ["s1"]);
});
test("cancel allowed despite unavailable recovery storage and reports warning", async () => {
  let n = 0;
  const x = setup({
    persistEvidence: () => false,
    post: async () => {
      n++;
      return view({
        lifecycle: "terminal",
        receiptState: "saved",
        recordSaved: true,
      });
    },
  });
  x.state.sessionId = "s1";
  await x.c.cancel();
  assert.equal(n, 1);
  assert.match(x.state.notice, /恢复标记保存失败/);
});
test("lost cancellation blocks new effects", async () => {
  const x = setup({
    post: async () => {
      throw Error("lost");
    },
  });
  x.state.sessionId = "s1";
  await x.c.cancel();
  assert.deepEqual(x.state.persistenceProblems, ["s1"]);
  await assert.rejects(x.c.start(), /未确认/);
});
test("concurrent cancellation keeps newer terminal evidence from late send", async () => {
  const d = deferred(),
    x = setup({
      post: async (path) =>
        path.endsWith("/send")
          ? d.promise
          : view({
              lifecycle: "terminal",
              receiptState: "saved",
              recordSaved: true,
            }),
    });
  x.state.session = view();
  x.state.sessionId = "s1";
  const sending = x.c.send();
  await x.c.cancel();
  d.resolve(view({ requestMessages: [{ sendState: "accepted" }] }));
  await sending;
  assert.equal(x.state.session.lifecycle, "terminal");
  assert.deepEqual(x.state.uncertainSessions, ["s1"]);
  assert.equal(x.busy.filter(([b]) => b).length, 1);
  assert.equal(x.busy.at(-1)[0], false);
});
test("malformed or wrong ID receipts never replace valid state", async () => {
  const x = setup({ get: async () => view({ id: "other" }) });
  x.state.session = view();
  x.state.sessionId = "s1";
  await x.c.poll();
  assert.equal(x.state.session.id, "s1");
  assert.match(x.state.notice, /回执无效/);
});
test("stale read cannot cross view ownership", async () => {
  const d = deferred(),
    x = setup({ get: () => d.promise });
  x.state.sessionId = "s1";
  const p = x.c.poll();
  invalidateGrpcStream(x.state);
  d.resolve(view());
  await p;
  assert.equal(x.state.session, null);
});
test("render escapes remote content and exposes record state explicitly", () => {
  const x = setup();
  x.state.session = view({ messages: ["<script>bad</script>"] });
  x.state.notice = "<img>";
  const html = renderGrpcStream(x.state, [{ id: "d1", name: "<x>" }]);
  assert.ok(!html.includes("<script>bad"));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /尚未终态/);
});
test("restored unknown-start cannot be cleared by manual ID GET", async () => {
  const x = setup();
  x.state.uncertainStart = true;
  x.state.sessionId = "s1";
  await x.c.poll();
  assert.equal(x.state.uncertainStart, true);
  await assert.rejects(x.c.start(), /未确认/);
});
test("recovered unverified session refuses new start and ID erasure", async () => {
  const x = setup();
  x.state.sessionId = "s1";
  x.state.sessionIdKnown = true;
  await assert.rejects(x.c.start(), /已有活动流/);
  assert.throws(() => x.c.edit("sessionId", ""), /不能更换/);
  await x.c.poll();
  assert.throws(() => x.c.edit("sessionId", "other"), /不能更换/);
  await assert.rejects(x.c.start(), /已有活动流/);
});
test("confirmed terminal saved permits deliberate different session ID", () => {
  const x = setup();
  x.state.sessionId = "s1";
  x.state.session = view({
    lifecycle: "terminal",
    recordSaved: true,
    receiptState: "saved",
  });
  x.c.edit("sessionId", "s2");
  assert.equal(x.state.sessionId, "s2");
  assert.equal(x.state.session, null);
});
test("terminal unknown write is preserved despite saved recording", async () => {
  const x = setup({
    post: async () =>
      view({
        lifecycle: "terminal",
        recordSaved: true,
        receiptState: "saved",
        requestMessages: [{ sendState: "unknown" }],
      }),
  });
  x.state.sessionId = "s1";
  x.state.session = view();
  await x.c.send();
  assert.deepEqual(x.state.uncertainSessions, ["s1"]);
  await assert.rejects(x.c.start(), /未知/);
});
test("unavailable halfclose receipt remains uncertain", async () => {
  const x = setup({
    post: async () =>
      view({
        lifecycle: "terminal",
        recordSaved: true,
        receiptState: "saved",
        requestState: "unavailable",
      }),
  });
  x.state.sessionId = "s1";
  x.state.session = view();
  await x.c.halfClose();
  assert.deepEqual(x.state.uncertainSessions, ["s1"]);
});
test("unary and wrong initial mode refused by read-only schema without unknown start", async () => {
  const x = setup({
    inspectDefinition: async () => ({
      services: [
        {
          name: "S",
          methods: [{ name: "M", requestStream: false, responseStream: false }],
        },
      ],
    }),
  });
  await x.c.start();
  assert.equal(x.calls.length, 0);
  assert.equal(x.state.uncertainStart, false);
  assert.match(x.state.notice, /单次调用/);
  x.options.inspectDefinition = async () => ({
    services: [
      {
        name: "S",
        methods: [{ name: "M", requestStream: false, responseStream: true }],
      },
    ],
  });
  await x.c.start();
  assert.equal(x.calls.length, 0);
  assert.equal(x.state.uncertainStart, false);
  assert.match(x.state.notice, /勾选/);
});
test("readonly schema ownership loss never dispatches start", async () => {
  const d = deferred(),
    x = setup({ inspectDefinition: () => d.promise });
  const p = x.c.start();
  invalidateGrpcStream(x.state);
  d.resolve({ services: [] });
  await p;
  assert.equal(x.calls.length, 0);
  assert.equal(x.state.uncertainStart, false);
});
test("read propagates backend unknown request entry even with saved terminal", async () => {
  const x = setup({
    get: async () =>
      view({
        lifecycle: "terminal",
        recordSaved: true,
        receiptState: "saved",
        requestMessages: [{ sendState: "unknown" }],
      }),
  });
  x.state.sessionId = "s1";
  await x.c.poll();
  assert.deepEqual(x.state.uncertainSessions, ["s1"]);
  await assert.rejects(x.c.start(), /未知/);
});
test("manual recovery ID typing commits only on change, not every character", () => {
  const x = setup(),
    input = { value: "" },
    root = {
      querySelector: (selector) =>
        selector === "#grpc-stream-sessionId" ? input : null,
    };
  bindGrpcStream(root, x.options);
  for (const c of "recovered-id") {
    input.value += c;
    input.oninput?.();
  }
  assert.equal(x.state.sessionId, "");
  input.onchange();
  assert.equal(x.state.sessionId, "recovered-id");
});
test("manual mistyped ID remains editable after read-only failure", async () => {
  const x = setup({
    get: async () => {
      throw Error("not found");
    },
  });
  x.c.edit("sessionId", "typo");
  await x.c.poll();
  assert.equal(x.state.sessionIdKnown, false);
  x.c.edit("sessionId", "correct");
  assert.equal(x.state.sessionId, "correct");
  x.c.edit("sessionId", "");
  assert.equal(x.state.sessionId, "");
});
test("successful manual lookup binds original ID against replacement", async () => {
  const x = setup();
  x.c.edit("sessionId", "s1");
  await x.c.poll();
  assert.equal(x.state.sessionIdKnown, true);
  assert.throws(() => x.c.edit("sessionId", "other"), /不能更换/);
  x.c.edit("sessionId", "s1");
  assert.equal(x.state.session.id, "s1");
});
test("cancellation intent binds manual ID before uncertain dispatch", async () => {
  const x = setup({
    post: async () => {
      throw Error("lost");
    },
  });
  x.c.edit("sessionId", "s1");
  await x.c.cancel();
  assert.equal(x.state.sessionIdKnown, true);
  assert.throws(() => x.c.edit("sessionId", "other"), /不能更换/);
});
