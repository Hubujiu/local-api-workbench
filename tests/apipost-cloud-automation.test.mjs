import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { createMCP } from "../src/mcp.mjs";
import { importIntoProject } from "../src/core.mjs";

const raw = await readFile(
  new URL("./fixtures/apipost-cloud-827.json", import.meta.url),
  "utf8",
);
const expected = [
  "/second",
  "/first-new",
  "/first",
  "/second",
  "/first-new",
  "/first",
];

test("8.2.7 owner import, manual run, native export and re-import preserve the recorded wire trace", async (t) => {
  const hits = [];
  const arrivals = [];
  const peer = createServer((req, res) => {
    hits.push(req.url);
    arrivals.push(performance.now());
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(path.join(os.tmpdir(), "apipost827-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    peer.closeAllConnections();
    await new Promise((r) => peer.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const call = async (p, route, data) => {
    const r = await fetch(app.url + "/api/projects/" + p.id + "/" + route, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const response = await r.json();
    assert.equal(r.status, 200, JSON.stringify(response));
    return response;
  };
  const first = await app.store.create("source"),
    second = await app.store.create("restored");
  const source = JSON.parse(
    raw.replaceAll(
      "http://127.0.0.1:1",
      "http://127.0.0.1:" + peer.address().port,
    ),
  );
  await call(first, "import", { document: source });
  assert.deepEqual(hits, []);
  const getPlan = async (p) => (await app.store.get(p.id)).plans[0];
  const run = async (p, trace = expected) => {
    const plan = await getPlan(p);
    const before = hits.length;
    const report = await call(p, "run", { planId: plan.id });
    assert.equal(report.status, "passed");
    assert.deepEqual(hits.slice(before), trace);
    assert.equal(report.results.filter((s) => s.status === "passed").length, 6);
  };
  await run(first);
  const doc = await call(first, "export?format=apipost");
  assert.equal(doc.automated_testings.length, 1);
  assert.equal(doc.automated_testings[0].settings.execute_count, 2);
  assert.deepEqual(
    doc.automated_testings[0].event_list.map((e) => [e.auto_sync, e.enabled]),
    [
      [true, 1],
      [true, 1],
      [false, 1],
      [true, -1],
    ],
  );
  const input = {
    format: "apipost",
    document: doc,
    selection: { mode: "all" },
  };
  const preview = await call(second, "import-preview", input);
  assert.ok(preview.token, JSON.stringify(preview));
  await call(second, "import-apply", { input, token: preview.token });
  assert.deepEqual(hits, expected);
  await run(second);
  const replay = await call(
    first,
    "export?format=apipost&automationMode=desktop-replay",
  );
  const portable = replay.automated_testings[0];
  assert.equal(portable.settings.execute_count, 1);
  assert.deepEqual(
    portable.event_list.map((e) => e.type),
    ["loop", "api", "api", "request", "api"],
  );
  const [loop, ...children] = portable.event_list;
  assert.equal(loop.data.limit, 2);
  assert.ok(children.every((step) => step.parent_event_id === loop.event_id));
  assert.equal(children[2].data.apiData.target_id, "");
  assert.ok(children[2].data.apiData.url.endsWith("/first"));
  const third = await app.store.create("desktop replay");
  const replayInput = { ...input, document: replay };
  const replayPreview = await call(third, "import-preview", replayInput);
  await call(third, "import-apply", {
    input: replayInput,
    token: replayPreview.token,
  });
  await run(third);
  const replayAgain = await call(third, "export?format=apipost");
  assert.deepEqual(
    replayAgain.automated_testings[0].event_list.map((e) => e.type),
    portable.event_list.map((e) => e.type),
  );
  const timed = await app.store.create("per request timing");
  const paced = structuredClone(source);
  paced.automated_testings[0].settings.interval_time = 70;
  await call(timed, "import", { document: paced });
  const start = arrivals.length;
  await run(timed);
  const gaps = arrivals
    .slice(start + 1)
    .map((at, i) => at - arrivals[start + i]);
  assert.equal(gaps.length, 5);
  assert.ok(
    gaps.every((gap) => gap >= 65),
    JSON.stringify(gaps),
  );
  assert.equal(
    (await call(timed, "export?format=apipost")).automated_testings[0].settings
      .interval_time,
    70,
  );
  await assert.rejects(
    call(timed, "export?format=apipost&automationMode=desktop-replay"),
    /逐请求间隔/,
  );
  const fromMcp = await app.store.create("agent roundtrip");
  const dispatch = createMCP({
    store: app.store,
    projects: [fromMcp.id],
    write: true,
    execute: false,
  });
  const mcp = async (name, args) => {
    const reply = await dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "localapi_" + name,
        arguments: { projectId: fromMcp.id, format: "apipost", ...args },
      },
    });
    assert.ok(
      reply.result && !reply.result.isError,
      JSON.stringify(reply.error ?? reply.result),
    );
    return JSON.parse(reply.result.content[0].text);
  };
  const priorHits = hits.length;
  await mcp("import_project", { document: doc });
  assert.deepEqual(
    (
      await mcp("export_project", { automationMode: "desktop-replay" })
    ).document.automated_testings[0].event_list.map((e) => e.type),
    portable.event_list.map((e) => e.type),
  );
  assert.equal(hits.length, priorHits);
  const edited = await app.store.get(fromMcp.id);
  const live = edited.requests.find((r) => r.url.endsWith("/first-new"));
  live.url = live.url.replace("/first-new", "/edited-in-workbench");
  await app.store.save(edited);
  await run(
    fromMcp,
    expected.map((url) =>
      url === "/first-new" ? "/edited-in-workbench" : url,
    ),
  );
  for (const change of [
    (t) => (t.event_list[0].data.loop_timeout = 1),
    (t) => (t.event_list[0].data.loop_traverse_data.iterationData = ["x"]),
    (t) => (t.event_list[1].parent_event_id = "0"),
    (t) => (t.event_list[3].data.apiData.target_id = "missing"),
    (t) => (t.settings.execute_count = 2),
  ]) {
    const invalid = structuredClone(replay),
      target = { requests: [], environments: [], settings: {} };
    change(invalid.automated_testings[0]);
    const old = structuredClone(target);
    assert.throws(
      () => importIntoProject(target, invalid),
      /automated_testings/,
    );
    assert.deepEqual(target, old);
  }
});

test("unsupported or ambiguous automation fails before changing the project", () => {
  for (const change of [
    (t) => (t.scenario = "timer"),
    (t) => (t.frequency.preset.config.interval = 8),
    (t) => t.event_list.reverse(),
    (t) => (t.event_list[1].sort = t.event_list[0].sort),
    (t) => (t.event_list[1].parent_event_id = t.event_list[0].event_id),
    (t) => (t.event_list[1].data.target_id = "missing"),
    (t) => (t.event_list[2].data.apiData = null),
    (t) => (t.event_list[1].auto_sync = false),
    (t) => (t.references_target_ids = []),
    (t) => (t.settings.iterates_data_id = "missing"),
    (t) => (t.settings.execute_count = 101),
    (t) => (t.settings.interval_time = 10001),
    (t) => {
      t.settings.interval_time = 800;
      t.settings.execute_count = 27;
    },
  ]) {
    const d = JSON.parse(raw),
      target = { requests: [], environments: [], settings: {} };
    change(d.automated_testings[0]);
    const saved = structuredClone(target);
    assert.throws(() => importIntoProject(target, d), /automated_testings/);
    assert.deepEqual(target, saved);
  }
});
