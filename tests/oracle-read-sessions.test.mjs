import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { OracleReadSessions } from "../src/oracle-read-sessions.mjs";
import { oracleInput } from "./helpers/oracle-fixture.mjs";

const grant = (sessions, extra = {}) =>
  sessions.register("owner", "project", {
    connection: oracleInput().connection,
    relations: ["fixture.items"],
    ...extra,
  });
const request = () => {
  const { sql, parameters } = oracleInput();
  return { sql, parameters };
};
const result = {
  rows: [{ AMOUNT: "9007199254740993.123456789" }],
  truncated: false,
};
test("Oracle session activation is explicit, listings contain no connection credentials", () => {
  assert.throws(() => grant(new OracleReadSessions()), /DISABLED/);
  const sessions = new OracleReadSessions({ enabled: true });
  try {
    const receipt = grant(sessions);
    assert.equal(receipt.type, "oracle");
    assert.deepEqual(sessions.list("owner", "project"), [receipt]);
    assert.deepEqual(sessions.list("other", "project"), []);
    assert.deepEqual(sessions.list("owner", "other"), []);
    assert.doesNotMatch(
      JSON.stringify(receipt),
      /private-secret|fixture.invalid|password|serverDN/,
    );
  } finally {
    sessions.close();
  }
});
test("same provider enforces owner, project and reviewed relation before dispatch", async () => {
  let calls = 0;
  const sessions = new OracleReadSessions({
    enabled: true,
    query: async () => {
      calls++;
      return result;
    },
  });
  try {
    const { id } = grant(sessions);
    await assert.rejects(
      sessions.query("other", "project", id, request()),
      /UNAVAILABLE/,
    );
    await assert.rejects(
      sessions.query("owner", "other", id, request()),
      /UNAVAILABLE/,
    );
    assert.throws(() => sessions.revoke("other", "project", id), /UNAVAILABLE/);
    await assert.rejects(
      sessions.query("owner", "project", id, {
        sql: "SELECT id FROM sys.session_privs",
      }),
      /RELATION_DENIED/,
    );
    await assert.rejects(
      sessions.query("owner", "project", id, {
        sql: "DELETE FROM fixture.items",
      }),
      /INPUT_INVALID/,
    );
    assert.equal(calls, 0);
    assert.deepEqual(
      await sessions.query("owner", "project", id, request()),
      result,
    );
    assert.equal(calls, 1);
  } finally {
    sessions.close();
  }
});
test("revocation aborts the exact in-flight read and suppresses even a late successful result", async () => {
  let finish, observed;
  const sessions = new OracleReadSessions({
    enabled: true,
    query: async (input, { signal }) => {
      observed = signal;
      return new Promise((r) => {
        finish = r;
      });
    },
  });
  const { id } = grant(sessions);
  const pending = sessions.query("owner", "project", id, request());
  sessions.revoke("owner", "project", id);
  assert.equal(observed.aborted, true);
  const replacement = grant(sessions);
  assert.notEqual(replacement.id, id);
  finish(result);
  await assert.rejects(pending, /CANCELLED/);
  await assert.rejects(
    sessions.query("owner", "project", id, request()),
    /UNAVAILABLE/,
  );
  sessions.close();
});
test("expiration cancels pending read and fences publication", async () => {
  let finish, observed;
  const sessions = new OracleReadSessions({
    enabled: true,
    query: async (input, { signal }) => {
      observed = signal;
      return new Promise((r) => {
        finish = r;
      });
    },
  });
  try {
    const { id } = grant(sessions, { ttlMs: 20 });
    const pending = sessions.query("owner", "project", id, request());
    await delay(40);
    assert.equal(observed.aborted, true);
    finish(result);
    await assert.rejects(pending, /CANCELLED/);
    assert.deepEqual(sessions.list("owner", "project"), []);
  } finally {
    sessions.close();
  }
});
test("credentials, query parameters and allowlists are snapshotted, errors are redacted", async () => {
  const connection = oracleInput().connection;
  const relations = ["fixture.items"];
  const parameters = [1];
  let observed;
  const sessions = new OracleReadSessions({
    enabled: true,
    query: async (input) => {
      await delay(1);
      observed = input;
      throw Error("private-secret");
    },
  });
  try {
    const { id } = grant(sessions, { connection, relations });
    connection.password = "changed";
    relations[0] = "sys.session_privs";
    const pending = sessions.query("owner", "project", id, {
      ...request(),
      parameters,
    });
    parameters[0] = 2;
    await assert.rejects(
      pending,
      (e) =>
        e.code === "ORACLE_SESSION_QUERY_FAILED" &&
        !String(e).includes("private-secret"),
    );
    assert.equal(observed.connection.password, "private-secret");
    assert.deepEqual(observed.parameters, [1]);
    await assert.rejects(
      sessions.query("owner", "project", id, {
        sql: "SELECT id FROM sys.session_privs",
      }),
      /RELATION_DENIED/,
    );
  } finally {
    sessions.close();
  }
});
test("caller cancellation and host close do not replay or publish", async () => {
  let calls = 0,
    finish,
    observed;
  const sessions = new OracleReadSessions({
    enabled: true,
    query: async (input, { signal }) => {
      calls++;
      observed = signal;
      return new Promise((r) => {
        finish = r;
      });
    },
  });
  const { id } = grant(sessions);
  const c = new AbortController();
  c.abort("private-secret");
  await assert.rejects(
    sessions.query("owner", "project", id, request(), { signal: c.signal }),
    /CANCELLED/,
  );
  assert.equal(calls, 0);
  const pending = sessions.query("owner", "project", id, request());
  sessions.close();
  assert.equal(observed.aborted, true);
  finish(result);
  await assert.rejects(pending, /CANCELLED/);
  assert.equal(calls, 1);
  assert.throws(() => grant(sessions), /DISABLED/);
  sessions.close();
});
test("malformed scopes, grants and accessor values reject without invocation", () => {
  const sessions = new OracleReadSessions({ enabled: true });
  let called = false;
  try {
    for (const relations of [
      [],
      ["fixture.items", "FIXTURE.ITEMS"],
      ["x.y@remote"],
      ["x.y;DELETE"],
      Array(1),
    ])
      assert.throws(() => grant(sessions, { relations }), /INPUT_INVALID/);
    const accessors = [];
    Object.defineProperty(accessors, "0", {
      get() {
        called = true;
      },
    });
    assert.throws(
      () => grant(sessions, { relations: accessors }),
      /INPUT_INVALID/,
    );
    const input = {};
    Object.defineProperty(input, "connection", {
      get() {
        called = true;
      },
    });
    assert.throws(
      () => sessions.register("owner", "project", input),
      /INPUT_INVALID/,
    );
    assert.equal(called, false);
    for (const ttlMs of [0, -1, 900001, NaN, "100"])
      assert.throws(() => grant(sessions, { ttlMs }), /INPUT_INVALID/);
    assert.throws(() => sessions.list("", "project"), /SCOPE_INVALID/);
    assert.throws(
      () =>
        grant(sessions, {
          connection: { ...oracleInput().connection, ssl: false },
        }),
      /INPUT_INVALID/,
    );
  } finally {
    sessions.close();
  }
});
test("session capacity is bounded and revoked grants release capacity", () => {
  const sessions = new OracleReadSessions({ enabled: true });
  try {
    const first = grant(sessions);
    for (let i = 1; i < 20; i++) grant(sessions);
    assert.throws(() => grant(sessions), /CAPACITY/);
    sessions.revoke("owner", "project", first.id);
    grant(sessions);
    assert.equal(sessions.list("owner", "project").length, 20);
  } finally {
    sessions.close();
  }
});

test("uncertain process cleanup is not mislabeled as ordinary cancellation", async () => {
  let rejectRead;
  const sessions = new OracleReadSessions({
    enabled: true,
    query: async () =>
      new Promise((resolve, reject) => {
        rejectRead = reject;
      }),
  });
  try {
    const { id } = grant(sessions);
    const pending = sessions.query("owner", "project", id, request());
    sessions.revoke("owner", "project", id);
    rejectRead(
      Object.assign(Error("private-secret"), {
        code: "ORACLE_READ_CLEANUP_UNCONFIRMED",
      }),
    );
    await assert.rejects(
      pending,
      (error) =>
        error.code === "ORACLE_SESSION_CLEANUP_UNCONFIRMED" &&
        !String(error).includes("private-secret"),
    );
  } finally {
    sessions.close();
  }
});
