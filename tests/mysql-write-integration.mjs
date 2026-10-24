import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import mysql from "mysql2/promise";
import { createApp } from "../src/server.mjs";
import { mutateMySQL, mysqlWriteUsage } from "../src/mysql-write.mjs";
import { queryRemoteDatabase } from "../src/remote-database.mjs";
import { DatabaseSessions } from "../src/database-sessions.mjs";
import { startSSHFixture } from "./fixtures/ssh-server.mjs";
export async function verifyMySQLWrites(common) {
  const root = await mkdtemp(path.join(tmpdir(), "mysql-write-http-"));
  const app = await createApp({ root, port: 0 });
  const setup = await mysql.createConnection({ ...common, port: 3306 });
  const table = "localapi_mysql_write_" + process.pid,
    nontransactional = table + "_myisam";
  const connection = { ...common, type: "mysql", port: 3306 };
  let ssh;
  try {
    await setup.query(
      `CREATE TABLE ${table}(id BIGINT PRIMARY KEY,value_text VARCHAR(100) NOT NULL,payload BLOB) ENGINE=InnoDB`,
    );
    await setup.query(`CREATE TABLE ${nontransactional}(id INT) ENGINE=MyISAM`);
    const project = await app.store.create("MySQL disposable write fixture");
    const endpoint = app.url + "/api/projects/" + project.id + "/database";
    const headers = {
      "content-type": "application/json",
      "x-local-token": app.token,
    };
    const post = async (body) => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...connection, ...body }),
      });
      return { status: response.status, value: await response.json() };
    };
    const write = (sql, parameters = []) =>
      post({ allowWrite: true, sql, parameters });
    const sql = `INSERT INTO ${table}(id,value_text,payload) VALUES (?,?,?)`;
    const parameters = [
      { type: "int64", value: "9007199254740993" },
      "initial",
      { type: "blob", base64: "AAH/" },
    ];
    const denied = await post({ sql, parameters });
    assert.notEqual(denied.status, 200);
    const inserted = await write(sql, parameters);
    assert.equal(inserted.status, 200, JSON.stringify(inserted));
    assert.equal(inserted.value.committed, true);
    const read = await queryRemoteDatabase({
      ...connection,
      sql: `SELECT id,value_text,payload FROM ${table}`,
    });
    assert.deepEqual(read.rows, [
      {
        id: "9007199254740993",
        value_text: "initial",
        payload: { type: "blob", base64: "AAH/" },
      },
    ]);
    const duplicate = await write(sql, parameters);
    assert.notEqual(duplicate.status, 200);
    assert.match(duplicate.value.error, /回滚/);
    assert.equal(
      (
        await write(`UPDATE ${table} SET value_text=? WHERE id=?`, [
          "updated",
          "9007199254740993",
        ])
      ).value.affectedRows,
      1,
    );
    assert.equal(
      (await write(`DELETE FROM ${table} WHERE id=?`, ["9007199254740993"]))
        .value.affectedRows,
      1,
    );
    assert.equal(
      (
        await queryRemoteDatabase({
          ...connection,
          sql: `SELECT id FROM ${table}`,
        })
      ).rows.length,
      0,
    );
    const nonAtomic = await write(
      `INSERT INTO ${nontransactional}(id) VALUES (?)`,
      [1],
    );
    assert.notEqual(nonAtomic.status, 200);
    assert.match(nonAtomic.value.error, /InnoDB/);
    assert.equal(
      (await setup.query(`SELECT COUNT(*) n FROM ${nontransactional}`))[0][0].n,
      0,
    );
    // Populate the boundary independently; production writers must not exceed it.
    await setup.query(
      `INSERT INTO ${table}(id,value_text) VALUES ` +
        Array.from({ length: 1001 }, () => "(?,?)").join(","),
      Array.from({ length: 1001 }, (_, i) => [i + 1, "same"]).flat(),
    );
    for (const sql of [
      `UPDATE ${table} SET value_text='same'`,
      `DELETE FROM ${table}`,
    ]) {
      const result = await write(sql);
      assert.notEqual(result.status, 200, JSON.stringify(result));
      assert.match(result.value.error, /1000/);
    }
    assert.equal(
      (await setup.query(`SELECT COUNT(*) n FROM ${table}`))[0][0].n,
      1001,
    );
    const boundary = await write(
      `UPDATE ${table} SET value_text=? WHERE id<=1000`,
      ["bounded"],
    );
    assert.equal(boundary.status, 200, JSON.stringify(boundary));
    assert.equal(boundary.value.affectedRows, 1000);
    // Session grants do not acquire manual write authority.
    const grants = new DatabaseSessions();
    const grant = grants.register(project.id, {
      ...connection,
      name: "read only",
    });
    await assert.rejects(
      grants.query(project.id, {
        connectionId: grant.id,
        sql: `DELETE FROM ${table}`,
        parameters: [],
      }),
      /SELECT/,
    );
    grants.revoke(project.id, grant.id);
    // Non-strict external servers may return warnings instead of errors. Roll back.
    await assert.rejects(
      mutateMySQL(
        {
          ...connection,
          allowWrite: true,
          sql: `UPDATE ${table} SET value_text=? WHERE id=1`,
          parameters: ["x".repeat(101)],
        },
        {
          async createConnection(options) {
            const c = await mysql.createConnection(options);
            await c.query("SET SESSION sql_mode=''");
            return c;
          },
        },
      ),
      /警告/,
    );
    assert.equal(
      (await setup.query(`SELECT value_text FROM ${table} WHERE id=1`))[0][0]
        .value_text,
      "bounded",
    );
    const start = performance.now();
    const timedWrite = write(
      `UPDATE ${table} SET value_text=IF(SLEEP(10)=0,'late','late') WHERE id=1`,
    );
    let runningId;
    const observeDeadline = Date.now() + 2000;
    while (!runningId && Date.now() < observeDeadline) {
      const [processes] = await setup.query({
        sql: "SHOW PROCESSLIST",
        timeout: 1000,
      });
      runningId = processes.find(
        (row) => row.Info?.includes(table) && row.Info?.includes("SLEEP(10)"),
      )?.Id;
      if (!runningId) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const timeout = await timedWrite;
    assert(runningId, "observe the actual owned sleeping DML before timeout");
    assert.notEqual(timeout.status, 200);
    assert.match(timeout.value.error, /超时.*未发出提交/);
    assert(performance.now() - start < 8000);
    let stillRunning = true;
    const cleanupDeadline = Date.now() + 2000;
    while (stillRunning && Date.now() < cleanupDeadline) {
      const [processes] = await setup.query({
        sql: "SHOW PROCESSLIST",
        timeout: 1000,
      });
      stillRunning = processes.some(
        (row) => Number(row.Id) === Number(runningId),
      );
      if (stillRunning) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      stillRunning,
      false,
      "owned database session must disappear after cancellation",
    );
    assert.equal(
      (await setup.query(`SELECT value_text FROM ${table} WHERE id=1`))[0][0]
        .value_text,
      "bounded",
    );
    // Concurrent DDL must wait behind the transaction-held target metadata lock.
    let releaseLock,
      announceLock,
      selected = false,
      altered = false,
      alter;
    const unlocked = new Promise((resolve) => {
      releaseLock = resolve;
    });
    const locked = new Promise((resolve) => {
      announceLock = resolve;
    });
    const observer = await mysql.createConnection({ ...common, port: 3306 });
    const mutation = mutateMySQL(
      {
        ...connection,
        allowWrite: true,
        sql: `UPDATE ${table} SET value_text=? WHERE id=1`,
        parameters: ["metadata-pinned"],
      },
      {
        async createConnection(options) {
          const c = await mysql.createConnection(options);
          if (!selected) {
            selected = true;
            const query = c.query.bind(c);
            c.query = async (q, ...args) => {
              const result = await query(q, ...args);
              if (q.sql?.startsWith("SELECT 1 FROM")) {
                announceLock();
                await unlocked;
              }
              return result;
            };
          }
          return c;
        },
      },
    );
    try {
      await Promise.race([
        locked,
        mutation.then(() => {
          throw Error("write finished before metadata checkpoint");
        }),
      ]);
      alter = setup
        .query({ sql: `ALTER TABLE ${table} ENGINE=MyISAM`, timeout: 5000 })
        .then(() => {
          altered = true;
        });
      alter.catch(() => {});
      let waiting = false;
      const end = Date.now() + 2000;
      while (!waiting && !altered && Date.now() < end) {
        const [processes] = await observer.query({
          sql: "SHOW PROCESSLIST",
          timeout: 1000,
        });
        waiting = processes.some(
          (row) =>
            Number(row.Id) === setup.threadId &&
            /metadata lock/i.test(row.State || ""),
        );
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert(waiting, "own ALTER must wait for the writer metadata lock");
      releaseLock();
      assert.equal((await mutation).committed, true);
      await alter;
      await setup.query(`ALTER TABLE ${table} ENGINE=InnoDB`);
    } finally {
      releaseLock();
      await Promise.allSettled([mutation, alter]);
      observer.destroy();
    }
    // Both the write and its owned cancellation connection use pinned SSH.
    ssh = await startSSHFixture({
      targets: [{ host: "database.fixture", port: 3306 }],
    });
    const sshInput = {
      ...connection,
      host: "database.fixture",
      ssh: ssh.ssh,
      allowWrite: true,
      sql: `UPDATE ${table} SET value_text=? WHERE id=1`,
      parameters: ["through-ssh"],
    };
    assert.equal((await mutateMySQL(sshInput)).committed, true);
    assert(ssh.stats.forwarded.length >= 2);
    assert.equal(
      (
        await queryRemoteDatabase({
          ...sshInput,
          sql: `SELECT value_text FROM ${table} WHERE id=1`,
          parameters: [],
        })
      ).rows[0].value_text,
      "through-ssh",
    );
    assert.equal(mysqlWriteUsage().active, 0);
    assert(
      !JSON.stringify(await app.store.get(project.id)).includes(
        common.password,
      ),
    );
    console.log(
      "Real MySQL HTTP opt-in -> typed write -> readback, rollback/limit/warnings/timeout, read-only grant isolation and pinned SSH writes passed",
    );
  } finally {
    await ssh?.close();
    await setup.query(`DROP TABLE IF EXISTS ${table}`);
    await setup.query(`DROP TABLE IF EXISTS ${nontransactional}`);
    await setup.end();
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  }
}
