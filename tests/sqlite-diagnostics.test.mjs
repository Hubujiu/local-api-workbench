import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, copyFile, writeFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { sqliteProcessErrorCode } from "../src/sqlite-process-diagnostics.mjs";

async function harness(t, entry, worker) {
  const root = await mkdtemp(path.join(tmpdir(), "sqlite-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["database-process.mjs", "sqlite-process-diagnostics.mjs"])
    await copyFile(
      new URL("../src/" + name, import.meta.url),
      path.join(root, name),
    );
  if (entry === null)
    await copyFile(
      new URL("../src/database-process-entry.mjs", import.meta.url),
      path.join(root, "database-process-entry.mjs"),
    );
  else await writeFile(path.join(root, "database-process-entry.mjs"), entry);
  if (worker !== undefined)
    await writeFile(path.join(root, "database-execution-worker.mjs"), worker);
  return {
    root,
    ...(await import(
      pathToFileURL(path.join(root, "database-process.mjs")).href
    )),
  };
}
function safe(error, code) {
  assert.equal(error.code, code);
  const text = JSON.stringify({
    diagnostics: error.diagnostics,
    cause: error.cause,
  });
  assert(text.length < 1024);
  assert(!text.includes("PRIVATE_SQL_SENTINEL"));
  assert(!text.includes("private-database-path"));
  return true;
}
test("SQLite diagnostic codes reject arbitrary error content", () => {
  assert.equal(
    sqliteProcessErrorCode({
      code: "ERR_WORKER_OUT_OF_MEMORY",
      message: "secret",
    }),
    "ERR_WORKER_OUT_OF_MEMORY",
  );
  assert.equal(
    sqliteProcessErrorCode({ code: "PRIVATE_SQL_SENTINEL" }),
    "OTHER",
  );
  assert.equal(sqliteProcessErrorCode(null), null);
});
test("status-only IPC is not a completed result and actual worker errors remain redacted", async (t) => {
  const h = await harness(
    t,
    null,
    `import {parentPort} from 'node:worker_threads';parentPort.postMessage({kind:'sqlite-worker-ready'});const e=Error('PRIVATE_SQL_SENTINEL');e.code='PRIVATE_SQL_SENTINEL';throw e;`,
  );
  await assert.rejects(
    h.runSQLiteProcess({
      mode: "write",
      sql: "PRIVATE_SQL_SENTINEL",
      filename: "private-database-path",
    }),
    (e) => {
      safe(e, "SQLITE_WRITE_OUTCOME_UNKNOWN");
      assert.equal(e.diagnostics.timeout, false);
      assert.equal(e.diagnostics.receivedResult, false);
      assert.equal(e.diagnostics.workerErrorCode, "OTHER");
      assert.equal(e.diagnostics.workerExitCode, 1);
      assert.equal(e.diagnostics.phase, "worker-exit");
      return true;
    },
  );
  const only = await harness(
    t,
    `process.once('message',()=>process.send({kind:'sqlite-stage',stage:'worker-ready'},()=>process.disconnect()));`,
  );
  await assert.rejects(only.runSQLiteProcess({ mode: "read" }), (e) => {
    safe(e, "SQLITE_QUERY_PROCESS_FAILED");
    assert.equal(e.diagnostics.exitCode, 0);
    assert.equal(e.diagnostics.receivedResult, false);
    assert.equal(e.diagnostics.phase, "worker-ready");
    return true;
  });
});
for (const completed of [false, true])
  test(
    `SQLite ${completed ? "completion IPC followed by hung process" : "startup without readiness"} retains hard deadline and never retries writes`,
    { timeout: 7000 },
    async (t) => {
      const h = await harness(
        t,
        `import {appendFileSync} from 'node:fs';process.once('message',input=>{appendFileSync(input.marker,'one\\n');${completed ? `process.send({kind:'sqlite-result',payload:{result:{ok:true}}});` : ""}setInterval(()=>{},100);});`,
      );
      const marker = path.join(h.root, "executions.txt");
      await assert.rejects(
        h.runSQLiteProcess({
          mode: "write",
          marker,
          sql: "PRIVATE_SQL_SENTINEL",
        }),
        (e) => {
          safe(e, "SQLITE_WRITE_OUTCOME_UNKNOWN");
          assert.equal(e.diagnostics.timeout, true);
          assert.equal(e.diagnostics.receivedResult, completed);
          assert.equal(
            e.diagnostics.phase,
            completed ? "result-received" : "process-spawned",
          );
          assert(e.diagnostics.elapsedMs >= 1900);
          return true;
        },
      );
      assert.equal(await readFile(marker, "utf8"), "one\n");
    },
  );
test("SQLite completed worker plus successful process close returns result and serialization failures expose code only", async (t) => {
  const h = await harness(
    t,
    null,
    `import {parentPort} from 'node:worker_threads';parentPort.postMessage({kind:'sqlite-worker-ready'});parentPort.postMessage({result:{rows:[{value:7}]}});`,
  );
  assert.deepEqual(await h.runSQLiteProcess({ mode: "read" }), {
    rows: [{ value: 7 }],
  });
  await assert.rejects(
    h.runSQLiteProcess({ mode: "write", fn: () => "PRIVATE_SQL_SENTINEL" }),
    (e) => {
      safe(e, "SQLITE_WRITE_OUTCOME_UNKNOWN");
      assert(e.diagnostics.sendErrorCode);
      assert.equal(e.cause.code, e.diagnostics.sendErrorCode);
      return true;
    },
  );
});

test("public SQLite diagnostics reconstruct only bounded known fields", async () => {
  const { sqliteProcessFailureDetails } = await import(
    "../src/sqlite-process-diagnostics.mjs"
  );
  const result = sqliteProcessFailureDetails({
    code: "SQLITE_WRITE_OUTCOME_UNKNOWN",
    message: "PRIVATE_SQL_SENTINEL",
    cause: { secret: "PRIVATE_SQL_SENTINEL" },
    diagnostics: {
      phase: "PRIVATE_SQL_SENTINEL",
      elapsedMs: Infinity,
      signal: "PRIVATE_SQL_SENTINEL",
      timeout: true,
      receivedResult: false,
      exitCode: 1,
      workerErrorCode: "PRIVATE_SQL_SENTINEL",
      sql: "PRIVATE_SQL_SENTINEL",
      filename: "private-database-path",
    },
  });
  assert.equal(result.diagnostics.phase, "unknown");
  assert.equal(result.diagnostics.workerErrorCode, "OTHER");
  assert.equal(result.diagnostics.elapsedMs, null);
  assert(!JSON.stringify(result).includes("PRIVATE_SQL_SENTINEL"));
  assert(!JSON.stringify(result).includes("private-database-path"));
  assert(JSON.stringify(result).length < 1024);
  assert.deepEqual(
    sqliteProcessFailureDetails({
      code: "OTHER",
      diagnostics: { phase: "worker-ready" },
    }),
    {},
  );
});

test(
  "authenticated HTTP preserves unknown-write protection and exposes only redacted stage evidence",
  { timeout: 10000 },
  async (t) => {
    const { createApp } = await import("../src/server.mjs");
    const { DatabaseSync } = await import("node:sqlite");
    const root = await mkdtemp(path.join(tmpdir(), "sqlite-http-diagnostics-")),
      app = await createApp({ root, port: 0 });
    t.after(async () => {
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
      await rm(root, { recursive: true, force: true });
    });
    const file = path.join(root, "private-database-path.db"),
      db = new DatabaseSync(file);
    db.exec(
      "CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO items VALUES(1,'before'); CREATE TRIGGER bounded AFTER UPDATE ON items BEGIN SELECT sum(x) FROM (WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT x FROM n); END;",
    );
    db.close();
    const p = await app.store.create("HTTP diagnostics"),
      endpoint = app.url + "/api/projects/" + p.id + "/database";
    const body = JSON.stringify({
      allowWrite: true,
      filename: file,
      sql: "UPDATE items SET value='PRIVATE_SQL_SENTINEL' WHERE id=1",
      parameters: [],
    });
    assert.equal(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        })
      ).status,
      403,
    );
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      body,
    });
    assert.equal(response.status, 400);
    const result = await response.json();
    assert.equal(result.code, "SQLITE_WRITE_OUTCOME_UNKNOWN");
    assert.match(result.error, /不要直接重试/);
    assert.equal(result.diagnostics.timeout, true);
    assert.equal(result.diagnostics.receivedResult, false);
    assert(!JSON.stringify(result).includes("PRIVATE_SQL_SENTINEL"));
    assert(!JSON.stringify(result).includes("private-database-path"));
    const recovery = new DatabaseSync(file);
    assert.equal(
      recovery.prepare("SELECT value FROM items").get().value,
      "before",
    );
    recovery.close();
  },
);
