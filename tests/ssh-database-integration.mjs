import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { Client } from "pg";
import { startSSHFixture } from "./fixtures/ssh-server.mjs";
import { queryRemoteDatabase } from "../src/remote-database.mjs";
import { mutatePostgres } from "../src/postgres-write.mjs";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
export async function verifySSHDatabaseFlows(common) {
  const fixture = await startSSHFixture({
    targets: [
      { host: "database.fixture", port: 5432 },
      { host: "database.fixture", port: 3306 },
    ],
  });
  const root = await mkdtemp(path.join(tmpdir(), "ssh-database-integration-"));
  const app = await createApp({ root, port: 0 });
  const echo = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ value: req.headers["x-database"] }));
  });
  await new Promise((r) => echo.listen(0, "127.0.0.1", r));
  const setup = new Client({ ...common, port: 5432 });
  await setup.connect();
  const table = "localapi_ssh_" + process.pid;
  try {
    await setup.query(
      `CREATE TABLE ${table}(id bigint primary key, value text)`,
    );
    for (const type of ["postgres", "mysql"]) {
      const input = {
        ...common,
        type,
        host: "database.fixture",
        ssh: fixture.ssh,
        sql:
          type === "postgres"
            ? "SELECT $1::bigint AS id"
            : "SELECT CAST(? AS SIGNED) AS id",
        parameters: [{ type: "int64", value: "9007199254740993" }],
      };
      assert.equal(
        (await queryRemoteDatabase(input)).rows[0].id,
        "9007199254740993",
      );
      await assert.rejects(
        queryRemoteDatabase({
          ...input,
          sql: "SELECT missing FROM no_such_fixture_table",
          parameters: [],
        }),
      );
    }
    const keySSH = { ...fixture.ssh, privateKey: fixture.privateKey };
    delete keySSH.password;
    const input = {
      ...common,
      type: "postgres",
      host: "database.fixture",
      ssh: keySSH,
      allowWrite: true,
      sql: `INSERT INTO ${table}(id,value) VALUES($1,$2)`,
      parameters: [{ type: "int64", value: "9007199254740993" }, "over-ssh"],
    };
    assert.equal((await mutatePostgres(input)).committed, true);
    await assert.rejects(mutatePostgres(input), /回滚/);
    assert.deepEqual(
      (
        await queryRemoteDatabase({
          ...input,
          sql: `SELECT id,value FROM ${table}`,
          parameters: [],
        })
      ).rows,
      [{ id: "9007199254740993", value: "over-ssh" }],
    );
    const project = await app.store.create("SSH real database flow"),
      other = await app.store.create("other");
    const headers = {
      "content-type": "application/json",
      "x-local-token": app.token,
    };
    const post = async (endpoint, body, id = project.id) => {
      const response = await fetch(
        app.url + "/api/projects/" + id + "/" + endpoint,
        { method: "POST", headers, body: JSON.stringify(body) },
      );
      return { status: response.status, value: await response.json() };
    };
    const registration = await post("database-connections", {
      ...common,
      type: "postgres",
      host: "database.fixture",
      ssh: fixture.ssh,
      name: "SSH private grant",
    });
    assert.equal(registration.status, 200);
    assert.deepEqual(Object.keys(registration.value).sort(), [
      "id",
      "name",
      "type",
    ]);
    const planRequest = {
      steps: [
        {
          request: {
            method: "GET",
            url: `http://127.0.0.1:${echo.address().port}/echo`,
            before: [
              {
                type: "database",
                connectionId: registration.value.id,
                sql: `SELECT value FROM ${table}`,
                parameters: [],
                path: "$.rows[0].value",
                name: "dbValue",
              },
            ],
            beforeScript:
              'apt.setRequestHeader("X-Database",apt.getVar("dbValue"));',
            afterScript:
              'pm.test("SSH database reached real HTTP",()=>pm.expect(pm.response.json().value).to.equal("over-ssh"));',
          },
        },
      ],
    };
    const plan = await post("plans", planRequest);
    assert.equal(plan.status, 200);
    const run = await post("run", { planId: plan.value.id });
    assert.equal(run.status, 200);
    assert.equal(run.value.status, "passed", JSON.stringify(run.value.results));
    assert.equal(
      JSON.parse(run.value.results[0].response.body).value,
      "over-ssh",
    );
    const persisted = await new Store(root).get(project.id);
    assert.equal(persisted.runs.at(-1).status, "passed");
    const saved = JSON.stringify(persisted);
    assert(!saved.includes(fixture.ssh.password));
    assert(!saved.includes(fixture.privateKey));
    const foreign = await post("plans", planRequest, other.id);
    assert.equal(foreign.status, 200);
    const forbidden = await post("run", { planId: foreign.value.id }, other.id);
    assert.equal(forbidden.value.status, "failed");
    assert.match(forbidden.value.results[0].error, /未授权/);
    console.log(
      "Real PostgreSQL/MySQL over pinned SSH, PostgreSQL write/rollback/readback, scoped grant -> script -> HTTP -> persisted plan passed",
    );
  } finally {
    await setup.query(`DROP TABLE IF EXISTS ${table}`);
    await setup.end();
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    echo.closeAllConnections();
    await new Promise((r) => echo.close(r));
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
}
