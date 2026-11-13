import test from "node:test";
import assert from "node:assert/strict";
import {
  protocolHistoryView,
  protocolHistoryDetail,
} from "../public/protocol-history-view.js";
test("all saved protocol types retain raw evidence without mutation", () => {
  const p = {
    id: "p",
    protocolRuns: ["grpc", "socketio", "tcp", "sse", "websocket"].map(
      (type) => ({
        type,
        id: type,
        status: "unknown",
        result: {
          messages: [{ body: "<script>secret</script>" }],
          recordSaved: false,
        },
      }),
    ),
  };
  const before = structuredClone(p);
  const view = protocolHistoryView(p);
  assert.equal((view.match(/data-protocol-history=/g) || []).length, 5);
  for (let i = 0; i < 5; i++) {
    const html = protocolHistoryDetail(p, "p", p.protocolRuns[i].id);
    assert.match(html, /&lt;script&gt;secret&lt;\/script&gt;/);
    assert.match(html, /recordSaved/);
    assert.match(html, /unknown/);
    assert.doesNotMatch(html, /<script>/);
  }
  assert.deepEqual(p, before);
  assert.match(view, /不证明远端业务成功/);
});
test("empty, stale project and invalid indices never reveal a record", () => {
  const p = { id: "p", protocolRuns: [{ id: "private" }] };
  assert.match(protocolHistoryView({ id: "p" }), /暂无/);
  for (const i of [
    "-1",
    "01",
    "1.0",
    "1e0",
    "",
    undefined,
    "1000",
    "__proto__",
  ])
    assert.equal(protocolHistoryDetail(p, "p", i), null);
  assert.equal(protocolHistoryDetail(p, "other", "0"), null);
  assert.equal(protocolHistoryDetail(null, "p", "0"), null);
});
test("summary fields and project attributes are HTML escaped", () => {
  const p = {
    id: '" onclick="bad',
    protocolRuns: [
      { id: "<img>", type: "<svg>", status: "<x>", createdAt: "<y>" },
    ],
  };
  const html = protocolHistoryView(p);
  assert.doesNotMatch(html, /<img>|<svg>|<x>|<y>|data-protocol-project=""/);
  assert.match(html, /&quot; onclick=&quot;bad/);
});

test("stable identity survives reordering; ambiguous identity refuses", () => {
  const p = {
    id: "p",
    protocolRuns: [
      { id: "one", result: { status: { code: 0 } } },
      { id: "two" },
    ],
  };
  assert.match(protocolHistoryView(p), /gRPC 状态码 0/);
  p.protocolRuns.reverse();
  assert.match(protocolHistoryDetail(p, "p", "one"), /one/);
  p.protocolRuns.push({ id: "one" });
  assert.equal(protocolHistoryDetail(p, "p", "one"), null);
});
