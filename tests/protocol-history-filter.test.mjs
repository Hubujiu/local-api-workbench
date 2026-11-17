import test from "node:test";
import assert from "node:assert/strict";
import {
  filterProtocolHistory,
  applyProtocolHistoryFilters,
  protocolHistoryView,
  protocolHistoryDetail,
  prepareProtocolHistoryExport,
} from "../public/protocol-history-view.js";
const project = {
  id: "p",
  protocolRuns: [
    {
      id: "one",
      type: "socketio",
      status: "unknown",
      result: { events: [{ body: "Needle 中文" }] },
    },
    { runId: "two", type: "grpc", result: { status: { code: 0 } } },
    { id: "three", type: "tcp", status: "failed" },
    { id: "four", type: "socketio", status: "failed" },
  ],
};
test("AND filters full saved content without mutation, including unknown evidence", () => {
  const before = structuredClone(project);
  assert.deepEqual(filterProtocolHistory(project), [0, 1, 2, 3]);
  assert.deepEqual(
    filterProtocolHistory(project, { query: "  NEEDLE 中文 " }),
    [0],
  );
  assert.deepEqual(
    filterProtocolHistory(project, { type: "socketio", status: "failed" }),
    [3],
  );
  assert.deepEqual(
    filterProtocolHistory(project, { status: "gRPC 状态码 0" }),
    [1],
  );
  assert.deepEqual(
    filterProtocolHistory(project, { query: "[invalid regex" }),
    [],
  );
  assert.deepEqual(project, before);
});
test("empty and unknown types/states stay honest", () => {
  assert.deepEqual(filterProtocolHistory({ id: "p" }), []);
  const p = { id: "p", protocolRuns: [{ id: "a" }] };
  assert.deepEqual(
    filterProtocolHistory(p, { type: "未知协议", status: "未提供状态" }),
    [0],
  );
  assert.match(protocolHistoryView(p), /未提供状态/);
  assert.match(protocolHistoryView(project), /当前已加载记录/);
});
test("options and raw query data do not inject markup", () => {
  const html = protocolHistoryView({
    id: "p",
    protocolRuns: [{ id: "x", type: '"><script>x</script>', status: "<img>" }],
  });
  assert.doesNotMatch(html, /<script>|<img>/);
  assert.match(html, /&lt;script&gt;/);
});
test("filtered stable identity retains exact detail and export", () => {
  const indices = filterProtocolHistory(project, {
    type: "socketio",
    status: "failed",
  });
  const id = project.protocolRuns[indices[0]].id;
  assert.match(protocolHistoryDetail(project, "p", id), /four/);
  assert.deepEqual(
    prepareProtocolHistoryExport(project, "p", id).confirm(project),
    project.protocolRuns[3],
  );
});
test("DOM adapter hides only rows, updates count and rejects foreign project", () => {
  const fields = {
    "#protocol-history-query": { value: "needle" },
    "#protocol-history-type": { value: "socketio" },
    "#protocol-history-status": { value: "unknown" },
    "#protocol-history-count": {},
    "#protocol-history-empty": {},
  };
  const rows = project.protocolRuns.map((_, index) => ({
    dataset: { protocolRow: String(index) },
    hidden: false,
  }));
  const root = {
    dataset: { protocolProject: "p" },
    querySelector: (s) => fields[s],
    querySelectorAll: () => rows,
  };
  assert.equal(
    applyProtocolHistoryFilters(root, { ...project, id: "other" }),
    false,
  );
  assert(rows.every((r) => r.hidden === false));
  assert.equal(applyProtocolHistoryFilters(root, project), true);
  assert.deepEqual(
    rows.map((r) => r.hidden),
    [false, true, true, true],
  );
  assert.match(fields["#protocol-history-count"].textContent, /1 \/ 4/);
  fields["#protocol-history-query"].value = "absent";
  applyProtocolHistoryFilters(root, project);
  assert.equal(fields["#protocol-history-empty"].hidden, false);
  for (const name of ["query", "type", "status"])
    fields["#protocol-history-" + name].value = "";
  applyProtocolHistoryFilters(root, project);
  assert(rows.every((r) => !r.hidden));
});

import { readFileSync } from "node:fs";
import vm from "node:vm";
test("actual app handlers prevent form navigation and clear through local adapter only", () => {
  const source = readFileSync(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  const handlers = {},
    calls = [];
  const root = {};
  let resets = 0,
    prevented = 0;
  const context = {
    project,
    applyProtocolHistoryFilters: (...args) => calls.push(args),
    $: (selector) =>
      selector === "#protocol-history" ? root : { reset: () => resets++ },
    on: (selector, event, fn) => (handlers[selector] = { event, fn }),
  };
  vm.runInNewContext(
    source.slice(
      source.indexOf('  on("#protocol-history-filter",'),
      source.indexOf('  on("[data-protocol-history]",'),
    ),
    context,
  );
  assert.equal(handlers["#protocol-history-filter"].event, "submit");
  handlers["#protocol-history-filter"].fn({
    preventDefault: () => prevented++,
  });
  assert.equal(prevented, 1);
  assert.equal(calls[0][0], root);
  assert.equal(calls[0][1], project);
  handlers["#protocol-history-filter-clear"].fn();
  assert.equal(resets, 1);
  assert.equal(calls.length, 2);
});

test("session state is explicitly labeled, not fabricated business success", () => {
  const p = {
    id: "p",
    protocolRuns: [
      {
        id: "stopped",
        type: "socketio",
        result: { state: "stopped", recordSaved: false },
      },
    ],
  };
  assert.deepEqual(filterProtocolHistory(p, { status: "会话状态 stopped" }), [
    0,
  ]);
  assert.deepEqual(filterProtocolHistory(p, { status: "success" }), []);
  assert.match(protocolHistoryView(p), /会话状态 stopped/);
});
