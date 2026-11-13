import test from "node:test";
import assert from "node:assert/strict";
import {
  prepareProtocolHistoryExport,
  protocolHistoryView,
} from "../public/protocol-history-view.js";
const project = () => ({
  id: "p",
  protocolRuns: [
    {
      id: "a",
      type: "socketio",
      status: "unknown",
      result: {
        events: [{ args: ["sensitive"], direction: "ack-sent" }],
        recordSaved: false,
      },
    },
  ],
});
test("explicit export clones exactly the previewed evidence, retains uncertainty, changes nothing", () => {
  const p = project(),
    before = structuredClone(p),
    prepared = prepareProtocolHistoryExport(p, "p", "a");
  assert.match(prepared.preview, /未脱敏/);
  const out = prepared.confirm(p);
  assert.deepEqual(out, p.protocolRuns[0]);
  out.result.events[0].args[0] = "mutated";
  assert.deepEqual(p, before);
  assert.match(protocolHistoryView(p), /data-protocol-history-export="a"/);
});
test("foreign, missing and ambiguous identity refuse before preview and confirmation", () => {
  const p = project(),
    prepared = prepareProtocolHistoryExport(p, "p", "a");
  assert.equal(prepareProtocolHistoryExport(p, "other", "a"), null);
  assert.equal(prepareProtocolHistoryExport(p, "p", "missing"), null);
  assert.throws(() => prepared.confirm({ ...p, id: "other" }), /变化/);
  assert.throws(() => prepared.confirm(null), /变化/);
  assert.throws(() => prepared.confirm({ ...p, protocolRuns: [] }), /变化/);
  p.protocolRuns.push(structuredClone(p.protocolRuns[0]));
  assert.equal(prepareProtocolHistoryExport(p, "p", "a"), null);
  assert.throws(() => prepared.confirm(p), /变化/);
});
test("changed evidence rejects; reorder and unrelated records do not change selected export", () => {
  const p = project(),
    prepared = prepareProtocolHistoryExport(p, "p", "a");
  p.protocolRuns.unshift({ id: "b" });
  assert.equal(prepared.confirm(p).id, "a");
  p.protocolRuns[1].status = "success";
  assert.throws(() => prepared.confirm(p), /变化/);
});
test("protocol types and nested raw fields preserved, no transport API needed", () => {
  for (const type of [
    "grpc",
    "grpc-session",
    "socketio",
    "sse",
    "websocket",
    "tcp",
  ]) {
    const p = project();
    p.protocolRuns[0].type = type;
    p.protocolRuns[0].result.binary = "AA==";
    assert.deepEqual(
      prepareProtocolHistoryExport(p, "p", "a").confirm(p),
      p.protocolRuns[0],
    );
  }
});

import { readFileSync } from "node:fs";
import vm from "node:vm";
const appSource = readFileSync(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);
function adapter(p) {
  let handler, dialog;
  const downloads = [];
  const context = {
    project: p,
    prepareProtocolHistoryExport,
    on: (selector, kind, fn) => (handler = fn),
    modal: (...args) => (dialog = args),
    download: (...args) => downloads.push(args),
  };
  vm.runInNewContext(
    appSource.slice(
      appSource.indexOf('  on("[data-protocol-history-export]"'),
      appSource.indexOf('  on("[data-history]"'),
    ),
    context,
  );
  return {
    context,
    downloads,
    open: () => {
      handler(null, {
        dataset: { protocolProject: "p", protocolHistoryExport: "a" },
      });
      return dialog;
    },
  };
}
test("actual adapter preview and dismissal never download; explicit confirmation exports exact preview", () => {
  const p = project(),
    a = adapter(p);
  const dismissed = a.open();
  assert.equal(a.downloads.length, 0);
  assert.match(dismissed[3], /确认下载未脱敏/);
  const reopened = a.open();
  assert.equal(a.downloads.length, 0);
  reopened[2]();
  assert.equal(a.downloads.length, 1);
  assert.equal(a.downloads[0][0], "protocol-record.json");
  assert.deepEqual(a.downloads[0][1], p.protocolRuns[0]);
});
test("actual adapter resolves current project at confirmation and refuses replaced/mutated/removed records", () => {
  for (const kind of ["project", "change", "delete", "duplicate"]) {
    const p = project(),
      a = adapter(p),
      dialog = a.open();
    if (kind === "project") a.context.project = { ...p, id: "other" };
    if (kind === "change") p.protocolRuns[0].status = "success";
    if (kind === "delete") p.protocolRuns = [];
    if (kind === "duplicate")
      p.protocolRuns.push(structuredClone(p.protocolRuns[0]));
    assert.throws(() => dialog[2](), /变化/);
    assert.equal(a.downloads.length, 0);
  }
});
