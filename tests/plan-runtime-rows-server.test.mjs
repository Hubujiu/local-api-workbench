import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { ProjectCommitUncertain } from "../src/project-commit-outcome.mjs";

async function fixture(t, items = [{ name: "a" }, { name: "b" }]) {
  const root = await mkdtemp(join(tmpdir(), "runtime-rows-server-"));
  const seen = [];
  let reply = async () => {};
  const peer = createServer(async (req, res) => {
    seen.push(req.url);
    await reply(req, res);
    if (!res.destroyed) res.end(JSON.stringify({ items }));
  });
  await new Promise((r) => peer.listen(0, "127.0.0.1", r));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    peer.closeAllConnections();
    await Promise.all([
      new Promise((r) => app.server.close(r)),
      new Promise((r) => peer.close(r)),
    ]);
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("runtime rows");
  const base = `http://127.0.0.1:${peer.address().port}`;
  const request = {
    url: base + "/{{name}}",
    beforeScript: "pm.environment.set('name',pm.iterationData.get('name'));",
  };
  const produce = {
    id: "producer",
    request: {
      url: base + "/producer",
      extract: [{ name: "items", source: "json", path: "$.items" }],
    },
  };
  const rows = {
    id: "rows",
    type: "repeat",
    rowsFrom: { scope: "runtime", name: "items" },
    maxRows: 3,
    steps: [{ id: "body", request }],
  };
  const call = async (route, data, method = "POST") => {
    const r = await fetch(app.url + "/api/" + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: JSON.stringify(data),
    });
    return { status: r.status, body: await r.json() };
  };
  const action = (route, data, method) =>
    call(`projects/${p.id}/${route}`, data, method);
  const plan = async (steps = [produce, rows]) => {
    const made = await action("plans", { name: "rows", steps });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    return made.body.id;
  };
  return {
    root,
    app,
    p,
    seen,
    base,
    produce,
    rows,
    call,
    action,
    plan,
    reply: (fn) => {
      reply = fn;
    },
  };
}

test("canonical owner endpoint materializes live runtime rows, executes actual rows and persists evidence", async (t) => {
  const f = await fixture(t);
  f.p.requests = [{ id: "live", url: f.base + "/live/{{name}}" }];
  await f.app.store.save(f.p);
  f.rows.steps[0].liveRequestId = "live";
  const planId = await f.plan();
  const r = await f.action("run", { planId });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, "passed");
  assert.equal(r.body.recordSaved, true);
  assert.deepEqual(f.seen, ["/producer", "/live/a", "/live/b"]);
  assert.equal(r.body.results.length, 3);
  assert.deepEqual(r.body.liveBindings, [
    { stepId: "body", requestId: "live" },
  ]);
  const stored = await f.app.store.get(f.p.id);
  assert.equal(stored.runs.length, 1);
  assert.equal(stored.runs[0].source, "manual");
  assert.deepEqual(stored.runs[0].snapshot.steps[1].rowsFrom, f.rows.rowsFrom);
});

for (const mode of ["empty", "false-if"]) {
  test(`${mode} potential database reads require owner grants before producer and grant checks do not open databases`, async (t) => {
    const f = await fixture(t, []);
    const filename = join(f.root, "must-not-be-created.sqlite");
    const grant = await f.action("database-connections", {
      name: "read",
      type: "sqlite",
      filename,
    });
    assert.equal(grant.status, 200);
    f.rows.steps[0].request.before = [
      {
        type: "database",
        connectionId: grant.body.id,
        sql: "SELECT 1",
        parameters: [],
        name: "result",
      },
    ];
    const body =
      mode === "false-if"
        ? {
            id: "false",
            type: "if",
            condition: {
              op: "eq",
              left: { literal: true },
              right: { literal: false },
            },
            steps: [f.rows],
          }
        : f.rows;
    const planId = await f.plan([f.produce, body]);
    const good = await f.action("run", { planId });
    assert.equal(good.status, 200, JSON.stringify(good.body));
    assert.equal(good.body.status, "passed");
    assert.deepEqual(f.seen, ["/producer"]);
    await assert.rejects(stat(filename), { code: "ENOENT" });
    await f.action("database-connections", { id: grant.body.id }, "DELETE");
    f.seen.length = 0;
    const denied = await f.action("run", { planId });
    assert.equal(denied.status, 400);
    assert.match(denied.body.error, /失效|授权|撤销/);
    assert.deepEqual(f.seen, []);
    await assert.rejects(stat(filename), { code: "ENOENT" });
    assert.equal((await f.app.store.get(f.p.id)).runs.length, 1);
  });
}

test("owner database grant revocation during producer prevents later row read without replay", async (t) => {
  const f = await fixture(t);
  const filename = join(f.root, "never-open.sqlite");
  const grant = await f.action("database-connections", {
    name: "read",
    filename,
  });
  f.rows.steps[0].request.before = [
    {
      type: "database",
      connectionId: grant.body.id,
      sql: "SELECT 1",
      name: "result",
    },
  ];
  const planId = await f.plan();
  f.reply(async (req) => {
    if (req.url === "/producer")
      await f.action("database-connections", { id: grant.body.id }, "DELETE");
  });
  const r = await f.action("run", { planId });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, "failed");
  assert.equal(r.body.recordSaved, true);
  assert.deepEqual(f.seen, ["/producer"]);
  await assert.rejects(stat(filename), { code: "ENOENT" });
});

for (const uncertain of [false, true]) {
  test(`runtime rows ${uncertain ? "unknown" : "failed"} record save preserves execution and never retries`, async (t) => {
    const f = await fixture(t);
    const planId = await f.plan();
    let attempts = 0;
    const append = f.app.store.append;
    f.app.store.append = async () => {
      attempts++;
      throw uncertain
        ? new ProjectCommitUncertain(f.p.id)
        : Error("private-path");
    };
    t.after(() => {
      f.app.store.append = append;
    });
    const r = await f.action("run", { planId });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "passed");
    assert.equal(r.body.recordSaved, false);
    assert.equal(r.body.recordId, null);
    assert.equal(r.body.attemptedRecordId, r.body.id);
    assert.equal(r.body.persistenceOutcome.retry_safe, false);
    assert.equal(
      r.body.persistenceOutcome.code,
      uncertain ? "PROJECT_COMMIT_UNCERTAIN" : "RECORD_SAVE_FAILED",
    );
    if (uncertain)
      assert.equal(r.body.persistenceOutcome.commit_outcome, "unknown");
    assert.equal(attempts, 1);
    assert.deepEqual(f.seen, ["/producer", "/a", "/b"]);
  });
}

test("owner cancellation preserves only started rows and saves cancellation evidence", async (t) => {
  const f = await fixture(t);
  const planId = await f.plan();
  let started;
  const entered = new Promise((r) => {
    started = r;
  });
  f.reply(async (req, res) => {
    if (req.url === "/a") {
      started();
      await new Promise((r) => res.once("close", r));
    }
  });
  const pending = f.action("run", { planId, runId: "runtime-rows-cancel" });
  await entered;
  assert.equal(
    (await f.call("cancel", { id: "runtime-rows-cancel" })).status,
    200,
  );
  const r = await pending;
  assert.equal(r.body.status, "cancelled");
  assert.equal(r.body.recordSaved, true);
  assert.deepEqual(f.seen, ["/producer", "/a"]);
  assert.equal((await f.app.store.get(f.p.id)).runs[0].status, "cancelled");
});

test("MCP-only database grants never authorize a canonical manual runtime rows run", async (t) => {
  const f = await fixture(t, []);
  assert.equal(
    (
      await f.call("mcp/config", {
        enabled: true,
        write: true,
        execute: true,
        projects: [f.p.id],
      })
    ).status,
    200,
  );
  const grant = await f.action("mcp-database-connections", {
    name: "MCP only",
    filename: join(f.root, "unused.sqlite"),
  });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
  f.rows.steps[0].request.before = [
    {
      type: "database",
      connectionId: grant.body.id,
      sql: "SELECT 1",
      name: "result",
    },
  ];
  const planId = await f.plan();
  const denied = await f.action("run", { planId });
  assert.equal(denied.status, 400, JSON.stringify(denied.body));
  assert.match(denied.body.error, /失效|授权/);
  assert.deepEqual(f.seen, []);
});

test("authorized owner runtime rows execute real declarative read-only SQLite queries", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const f = await fixture(t);
  const filename = join(f.root, "read.sqlite");
  const db = new DatabaseSync(filename);
  db.exec(
    "CREATE TABLE source (value TEXT); INSERT INTO source VALUES ('read-value')",
  );
  db.close();
  const grant = await f.action("database-connections", {
    name: "read",
    filename,
  });
  assert.equal(grant.status, 200);
  f.rows.steps[0].request.before = [
    {
      type: "database",
      connectionId: grant.body.id,
      sql: "SELECT value FROM source",
      path: "$.rows[0].value",
      name: "value",
    },
  ];
  f.rows.steps[0].request.url = f.base + "/{{name}}/{{value}}";
  const planId = await f.plan();
  const r = await f.action("run", { planId });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, "passed", JSON.stringify(r.body));
  assert.equal(r.body.recordSaved, true);
  assert.deepEqual(f.seen, ["/producer", "/a/read-value", "/b/read-value"]);
  const check = new DatabaseSync(filename, { readOnly: true });
  assert.equal(check.prepare("SELECT count(*) AS n FROM source").get().n, 1);
  check.close();
});
