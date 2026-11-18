import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compileDamengRead } from "../src/dameng-read-contract.mjs";
import {
  runDamengRead,
  DAMENG_READ_DRIVER_STATUS,
} from "../src/dameng-read.mjs";
const input = () => ({
  connection: {
    host: "fixture.invalid",
    serverName: "fixture.invalid",
    port: 5236,
    user: "reader",
    password: "private-secret",
    ssl: true,
    ca: "synthetic CA",
  },
  sql: "SELECT id, amount FROM fixture.items WHERE id=:p0",
  parameters: [1],
});
function fixture({
  peer = {},
  readOnly = true,
  rows = [["9223372036854775807", "9007199254740993.123456789"]],
  type = "decimal",
  holdClose = false,
  closeFails = false,
  query,
} = {}) {
  const calls = [];
  let release, reject;
  const closed = new Promise((r, j) => {
    release = r;
    reject = j;
  });
  const port = {
    closed,
    async connect() {
      calls.push("connect");
      return {
        host: "fixture.invalid",
        serverName: "fixture.invalid",
        port: 5236,
        certificateVerified: true,
        protocol: "TLSv1.3",
        ...peer,
      };
    },
    async readOnly() {
      calls.push("read-only");
      return readOnly;
    },
    async query(plan, sink) {
      calls.push(plan);
      if (query) return query(sink);
      sink.metadata([
        { name: "ID", type: "int64" },
        { name: "AMOUNT", type },
      ]);
      for (const r of rows) sink.row(r);
    },
    destroy() {
      calls.push("destroy");
      if (!holdClose) {
        if (closeFails) reject(Error("private-secret"));
        else release();
      }
    },
  };
  return { factory: () => port, calls, release, reject };
}
test("bounded DM dialect is regenerated, parameters never interpolated", () => {
  const a = input();
  a.parameters = ["'; DROP TABLE x"];
  const p = compileDamengRead(a);
  assert.equal(
    p.sql,
    'SELECT TOP 1001 "ID", "AMOUNT" FROM "FIXTURE"."ITEMS" WHERE "ID" = :p0',
  );
  assert.equal(p.binds.p0, a.parameters[0]);
  assert.doesNotMatch(p.sql, /DROP/);
  for (const sql of [
    "SELECT * FROM fixture.items",
    "SELECT id FROM fixture.items@link",
    "SELECT id FROM fixture.items FOR UPDATE",
    "CALL p()",
    "SELECT x() FROM fixture.items",
    "SELECT id FROM fixture.items; DELETE FROM fixture.items",
    "SELECT id FROM fixture.items WHERE id=1",
  ])
    assert.throws(() => compileDamengRead({ ...a, sql }));
});
test("no implicit package, external module or request-provided factory can enable transport", async () => {
  assert.equal(DAMENG_READ_DRIVER_STATUS.available, false);
  await assert.rejects(
    runDamengRead(input()),
    /DAMENG_VERIFIED_TRANSPORT_UNAVAILABLE/,
  );
  await assert.rejects(
    runDamengRead({
      ...input(),
      factory: () => {
        throw Error("called");
      },
    }),
    /DAMENG_READ_INPUT_INVALID/,
  );
  await assert.rejects(
    runDamengRead(input(), {
      factory() {
        throw Error("private-secret");
      },
    }),
    /DAMENG_READ_FAILED_NO_RESULT/,
  );
  const p = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url)),
  );
  assert.equal(p.dependencies.dmdb, undefined);
});
test("rejects wrong target, unverified certificate, old TLS and no read-only transaction before SQL", async () => {
  for (const patch of [
    { peer: { certificateVerified: false } },
    { peer: { host: "other.invalid" } },
    { peer: { serverName: "other.invalid" } },
    { peer: { port: 5237 } },
    { peer: { protocol: "TLSv1" } },
    { readOnly: false },
  ]) {
    const f = fixture(patch);
    await assert.rejects(
      runDamengRead(input(), f),
      /DAMENG_READ_FAILED_NO_RESULT/,
    );
    assert.ok(f.calls.every((c) => typeof c === "string"));
    assert.equal(f.calls.at(-1), "destroy");
  }
});
test("synthetic typed exchange preserves exact numeric strings and waits for closure receipt", async () => {
  const f = fixture({ holdClose: true });
  let settled = false;
  const pending = runDamengRead(input(), f).then((r) => {
    settled = true;
    return r;
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(settled, false);
  f.release();
  const r = await pending;
  assert.equal(r.rows[0].AMOUNT, "9007199254740993.123456789");
  assert.equal(r.rows[0].ID, "9223372036854775807");
});
test("lossy values, unsupported types, overflow and cleanup failure discard all results", async () => {
  for (const setup of [
    { rows: [[1, "2"]] },
    { rows: [["9223372036854775808", "2"]] },
    { rows: [["1", 1.1]] },
    { rows: [["1", "1e20"]] },
    { rows: [["1", "NaN"]] },
    { type: "timestamp" },
    { rows: Array(1001).fill(["1", "2"]) },
    { closeFails: true },
  ])
    await assert.rejects(
      runDamengRead(input(), fixture(setup)),
      /DAMENG_READ_FAILED_NO_RESULT/,
    );
});
test("revocation is not a closure receipt and late rows cannot publish", async () => {
  const c = new AbortController();
  let sink,
    settled = false;
  const f = fixture({
    holdClose: true,
    query(s) {
      sink = s;
      return new Promise(() => {});
    },
  });
  const p = runDamengRead(input(), { ...f, signal: c.signal });
  p.catch(() => {
    settled = true;
  });
  await new Promise((r) => setTimeout(r, 10));
  c.abort("private-secret");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(settled, false);
  sink.metadata([]);
  f.release();
  await assert.rejects(p, /DAMENG_READ_CANCELLED/);
});
