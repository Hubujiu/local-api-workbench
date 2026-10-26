import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mutateMySQL, mysqlWriteUsage } from "../src/mysql-write.mjs";
import { createApp } from "../src/server.mjs";
import { startMySQLWritePeer } from "./fixtures/mysql-write-peer.mjs";

async function bounded(promise, label, milliseconds = 5000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("fixture deadline: " + label)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function until(predicate, label, milliseconds = 3000) {
  const end = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() > end) throw Error("fixture checkpoint: " + label);
    await delay(5);
  }
}
const settle = (promise) =>
  promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
const stages = (f) => f.records.map((record) => record.stage);
function closed(f, count = 2) {
  assert.equal(f.clients.length, count, "observe every actual client socket");
  assert(
    f.clients.every((client) => client.closed),
    "all owned socket close events precede return/lease release",
  );
  assert.equal(mysqlWriteUsage().active, 0);
}
function noLeak(message, f) {
  for (const secret of [
    f.input.password,
    f.input.parameters[1],
    "fictional-server-secret-bound-value",
  ])
    assert(
      !message.includes(secret),
      "never echo credentials, bindings or server error detail",
    );
}
async function appFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "mysql-write-lifecycle-"));
  let app = await createApp({ root, port: 0 });
  const stop = async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    await stop();
    await rm(root, { recursive: true, force: true });
  });
  return {
    get app() {
      return app;
    },
    async restart() {
      await stop();
      app = await createApp({ root, port: 0 });
    },
    async post(project, input) {
      const response = await fetch(
        `${app.url}/api/projects/${project.id}/database`,
        {
          method: "POST",
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          body: JSON.stringify(input),
        },
      );
      return { status: response.status, body: await response.json() };
    },
  };
}

test("real mysql2 full prepared write observes metadata, binds once and closes both half-open transports before success", async () => {
  const f = await startMySQLWritePeer();
  try {
    const result = await bounded(
      mutateMySQL(f.input, { queryTimeoutMs: 200 }),
      "success",
    );
    assert.deepEqual(result, {
      columns: [],
      rows: [],
      affectedRows: 1,
      committed: true,
      truncated: false,
      limit: 1000,
    });
    assert.deepEqual(stages(f), [
      "setup",
      "start",
      "metadata-lock",
      "metadata-prepare",
      "metadata-execute",
      "dml-prepare",
      "dml-execute",
      "commit",
    ]);
    const metadata = f.records.find(
      (record) => record.stage === "metadata-execute",
    );
    assert(metadata.bytes.includes(Buffer.from("fixture")));
    assert(metadata.bytes.includes(Buffer.from("entries")));
    const write = f.records.find((record) => record.stage === "dml-execute");
    assert(write.bytes.includes(Buffer.from(f.input.parameters[1])));
    assert(
      !f.records
        .find((record) => record.stage === "dml-prepare")
        .sql.includes(f.input.parameters[1]),
    );
    closed(f);
  } finally {
    await f.close();
  }
});

test(
  "held setup, metadata and DML PREPARE/execute, COMMIT and ROLLBACK are bounded by owned transport deadlines",
  { timeout: 20000 },
  async () => {
    for (const stage of [
      "setup",
      "start",
      "metadata-lock",
      "metadata-prepare",
      "metadata-execute",
      "dml-prepare",
      "dml-execute",
      "commit",
      "rollback",
    ]) {
      const f = await startMySQLWritePeer({
        hold: stage,
        count: stage === "rollback" ? 1001 : 1,
      });
      try {
        const started = performance.now();
        const { error } = await bounded(
          settle(mutateMySQL(f.input, { queryTimeoutMs: 100 })),
          stage,
        );
        assert(error instanceof Error, stage);
        assert.match(error.message, /超时|未确认|回滚确认/, stage);
        noLeak(error.message, f);
        assert(
          performance.now() - started < 2500,
          stage + " must not retain a hung phase",
        );
        assert(
          f.peers.some((peer) => peer.stage === stage) ||
            stage.startsWith("dml-"),
          "reach held wire phase",
        );
        if (
          [
            "setup",
            "start",
            "metadata-lock",
            "metadata-prepare",
            "metadata-execute",
            "dml-prepare",
          ].includes(stage)
        )
          assert(
            !stages(f).includes("dml-execute"),
            "no user DML before held preparation completes",
          );
        if (stage === "commit") {
          assert.match(error.message, /提交结果未确认/);
          assert(
            !stages(f).includes("rollback"),
            "ROLLBACK cannot undo unknown COMMIT",
          );
          assert(
            !stages(f).includes("kill"),
            "never KILL after COMMIT was attempted",
          );
        } else assert(!stages(f).includes("commit"));
        if (stage === "rollback") assert.match(error.message, /回滚确认/);
        if (stage === "dml-prepare" || stage === "dml-execute")
          assert.deepEqual(
            f.records
              .filter((record) => record.stage === "kill")
              .map((record) => record.sql),
            ["KILL QUERY 41"],
          );
        closed(f);
        const count = f.records.length;
        f.peers.forEach((peer) => peer.release());
        await delay(20);
        assert.equal(
          f.records.length,
          count,
          "late phase completion never queues another command",
        );
      } finally {
        await f.close();
      }
    }
  },
);

test(
  "both data and control authentication deadlines close all acquired sockets",
  { timeout: 12000 },
  async () => {
    for (const stage of ["data-handshake", "control-handshake"]) {
      const f = await startMySQLWritePeer({ hold: stage });
      try {
        const started = performance.now();
        const { error } = await bounded(settle(mutateMySQL(f.input)), stage);
        assert(error instanceof Error);
        assert.match(error.message, /超时|连接/);
        assert(performance.now() - started < 4500);
        assert.deepEqual(
          f.records,
          [],
          "failed authentication must send no SQL",
        );
        closed(f, stage === "data-handshake" ? 1 : 2);
      } finally {
        await f.close();
      }
    }
  },
);

test(
  "wire failures preserve rollback and unknown-commit distinctions without leaking server detail or replaying DML",
  { timeout: 10000 },
  async () => {
    for (const stage of [
      "setup",
      "start",
      "metadata-lock",
      "metadata-prepare",
      "metadata-execute",
      "dml-prepare",
      "dml-execute",
      "commit",
      "rollback",
    ]) {
      const f = await startMySQLWritePeer({
        fail: stage,
        count: stage === "rollback" ? 1001 : 1,
      });
      try {
        const { error } = await bounded(
          settle(mutateMySQL(f.input, { queryTimeoutMs: 200 })),
          stage,
        );
        assert(error instanceof Error, stage);
        noLeak(error.message, f);
        assert(
          f.records.filter((record) => record.stage === "dml-execute").length <=
            1,
        );
        if (stage === "commit") {
          assert.match(error.message, /提交结果未确认/);
          assert(!stages(f).includes("rollback"));
        } else if (stage === "rollback")
          assert.match(error.message, /回滚确认/);
        else if (!["setup", "start"].includes(stage)) {
          assert.match(error.message, /已回滚/);
          assert(stages(f).includes("rollback"));
        }
        closed(f);
      } finally {
        await f.close();
      }
    }
  },
);

test("whole-operation deadline prevents individually timely phases from running without a total bound", async () => {
  const f = await startMySQLWritePeer({
    delays: {
      setup: 80,
      start: 80,
      "metadata-lock": 80,
      "metadata-prepare": 80,
    },
  });
  try {
    const started = performance.now();
    const { error } = await bounded(
      settle(
        mutateMySQL(f.input, { queryTimeoutMs: 200, operationTimeoutMs: 350 }),
      ),
      "whole operation",
    );
    assert(error instanceof Error);
    assert.match(error.message, /超时|时限|超过/);
    assert(performance.now() - started < 1500);
    assert(!stages(f).includes("dml-execute"));
    assert(!stages(f).includes("commit"));
    closed(f);
  } finally {
    await f.close();
  }
});

test("a held own-thread KILL cannot keep a timed-out DML or either transport alive", async () => {
  const f = await startMySQLWritePeer({ hold: ["dml-execute", "kill"] });
  try {
    const started = performance.now();
    const { error } = await bounded(
      settle(
        mutateMySQL(f.input, { queryTimeoutMs: 100, operationTimeoutMs: 1200 }),
      ),
      "held KILL",
    );
    assert(error instanceof Error);
    assert.match(error.message, /超时/);
    assert.deepEqual(
      f.records
        .filter((record) => record.stage === "kill")
        .map((record) => record.sql),
      ["KILL QUERY 41"],
    );
    assert(!stages(f).includes("commit"));
    assert(performance.now() - started < 2000);
    closed(f);
  } finally {
    await f.close();
  }
});

test(
  "owner HTTP metadata PREPARE and SET deadlines close real transports without persisting credentials or mutating projects across restart",
  { timeout: 12000 },
  async (t) => {
    const a = await appFixture(t),
      project = await a.app.store.create("MySQL lifecycle project"),
      other = await a.app.store.create("Independent project");
    const before = await a.app.store.get(project.id),
      otherBefore = await a.app.store.get(other.id);
    for (const stage of ["setup", "metadata-prepare"]) {
      const f = await startMySQLWritePeer({ hold: stage });
      try {
        const response = await bounded(
          a.post(project, f.input),
          "owner HTTP " + stage,
        );
        assert.equal(response.status, 400);
        assert.match(response.body.error, /超时/);
        noLeak(JSON.stringify(response.body), f);
        assert(!stages(f).includes("dml-execute"));
        assert(!stages(f).includes("commit"));
        closed(f);
        assert.deepEqual(await a.app.store.get(project.id), before);
        assert.deepEqual(await a.app.store.get(other.id), otherBefore);
      } finally {
        await f.close();
      }
    }
    await a.restart();
    assert.deepEqual(await a.app.store.get(project.id), before);
    assert.deepEqual(await a.app.store.get(other.id), otherBefore);
  },
);

test(
  "five real stalled writes retain capacity until actual close and a different project can write afterward",
  { timeout: 12000 },
  async (t) => {
    const a = await appFixture(t),
      project = await a.app.store.create("Capacity owner"),
      other = await a.app.store.create("Capacity recovery"),
      f = await startMySQLWritePeer({ hold: "setup" });
    try {
      const pending = Array.from({ length: 5 }, () => a.post(project, f.input));
      await until(
        () =>
          f.records.filter((record) => record.stage === "setup").length === 5,
        "five setup operations",
      );
      assert.equal(mysqlWriteUsage().active, 5);
      const rejected = await a.post(other, f.input);
      assert.equal(rejected.status, 400);
      assert.match(rejected.body.error, /最多同时执行5/);
      const results = await bounded(Promise.all(pending), "capacity cleanup");
      assert(results.every((result) => result.status === 400));
      closed(f, 10);
      const good = await startMySQLWritePeer();
      try {
        const recovered = await a.post(other, good.input);
        assert.equal(recovered.status, 200);
        assert.equal(recovered.body.committed, true);
        closed(good);
      } finally {
        await good.close();
      }
    } finally {
      await f.close();
    }
  },
);

test(
  "disconnecting owner HTTP does not revoke an explicitly authorized write already awaiting COMMIT",
  { timeout: 5000 },
  async (t) => {
    const a = await appFixture(t),
      project = await a.app.store.create("Disconnected explicit writer"),
      f = await startMySQLWritePeer({ hold: "commit" });
    let request;
    try {
      request = http.request(
        `${a.app.url}/api/projects/${project.id}/database`,
        {
          method: "POST",
          headers: {
            "x-local-token": a.app.token,
            "content-type": "application/json",
          },
        },
      );
      request.on("error", () => {});
      request.end(JSON.stringify(f.input));
      await until(() => stages(f).includes("commit"), "COMMIT attempted");
      request.destroy();
      await delay(30);
      assert.equal(
        mysqlWriteUsage().active,
        1,
        "owner disconnect is not a write cancellation authority",
      );
      assert(f.clients.every((client) => !client.closed));
      f.peers.forEach((peer) => peer.release());
      await until(
        () => mysqlWriteUsage().active === 0,
        "acknowledged write closes resources",
      );
      closed(f);
      assert.equal(
        stages(f).filter((stage) => stage === "dml-execute").length,
        1,
      );
      assert(!stages(f).includes("rollback"));
      assert(!stages(f).includes("kill"));
    } finally {
      request?.destroy();
      await f.close();
    }
  },
);
