import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { resolveDynamicRequest } from "../src/dynamic-values.mjs";
import { interpolate } from "../src/core.mjs";
import { runLoad } from "../src/load-runner.mjs";

// Tests in this file are serial. Patches affect this test process only, never
// production hooks or the separately isolated script workers.
async function withCivilClock(run) {
  const original = Date.now;
  let offset = 0;
  Date.now = () => original() + offset;
  try {
    return await run((value) => {
      offset = value;
    });
  } finally {
    Date.now = original;
  }
}
const request = {
  query: [
    {
      key: "n",
      value: "",
      dynamic: {
        source: "fixed",
        value: 3,
        functions: ["double"],
      },
    },
  ],
};
const functions = [
  { name: "double", kind: "transform", body: "return text * 2;" },
];

test("civil clock jumps do not prematurely reject a real dynamic transform", async () => {
  const original = Date.now;
  for (const offset of [60000, -60000]) {
    const result = await withCivilClock((jump) =>
      resolveDynamicRequest(request, {}, functions, (value, variables) => {
        jump(offset);
        return interpolate(value, variables);
      }),
    );
    assert.equal(result.query[0].value, "6");
    assert.equal(Date.now, original);
  }
});

test("civil rollback cannot extend the five-second aggregate dynamic budget", async () => {
  const original = Date.now;
  let interpolations = 0;
  await withCivilClock(async (jump) => {
    await assert.rejects(
      resolveDynamicRequest(request, {}, functions, (value, variables) => {
        interpolations++;
        jump(-60000);
        const cell = new Int32Array(new SharedArrayBuffer(4));
        assert.equal(Atomics.wait(cell, 0, 0, 5100), "timed-out");
        return interpolate(value, variables);
      }),
      /动态值处理超过5秒总预算/,
    );
  });
  assert.equal(interpolations, 1);
  assert.equal(Date.now, original);
});

const project = {
  environments: [{ id: "default", name: "Default", variables: {} }],
  settings: {},
};
async function withHTTP(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run("http://127.0.0.1:" + server.address().port);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("forward civil jump does not truncate duration-load HTTP admission", async () => {
  const original = Date.now;
  let seen = 0;
  const result = await withCivilClock((jump) =>
    withHTTP(
      (_req, res) => {
        seen++;
        jump(120000);
        res.end("ok");
      },
      (url) =>
        runLoad(
          project,
          { url },
          {
            mode: "duration",
            durationSeconds: 60,
            count: 2,
            concurrency: 1,
          },
        ),
    ),
  );
  assert.equal(Date.now, original);
  assert.equal(seen, 2);
  assert.equal(result.stopReason, "count-limit");
  assert.equal(result.passed, 2);
  assert(Number.isSafeInteger(result.elapsed) && result.elapsed >= 0);
  assert(
    result.results.every(
      (row) => Number.isSafeInteger(row.elapsed) && row.elapsed >= 0,
    ),
  );
});

test("rollback preserves load cancellation timer and nonnegative elapsed evidence", async () => {
  const original = Date.now;
  let seen = 0;
  const result = await withCivilClock((jump) =>
    withHTTP(
      () => {
        seen++;
        jump(-120000);
        // Keep the owned request pending until the unchanged duration timer aborts.
      },
      (url) =>
        runLoad(
          project,
          { url },
          {
            mode: "duration",
            durationSeconds: 1,
            count: 2,
            concurrency: 1,
          },
        ),
    ),
  );
  assert.equal(Date.now, original);
  assert.equal(seen, 1);
  assert.equal(result.stopReason, "duration");
  assert.equal(result.passed, 0);
  assert(result.results.every((row) => row.interrupted));
  assert(Number.isSafeInteger(result.elapsed) && result.elapsed >= 950);
});
