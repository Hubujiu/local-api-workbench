import test from "node:test";
import assert from "node:assert/strict";
import { runScript } from "../src/scripts.mjs";
import { runPlan, snapshotPlan } from "../src/core.mjs";
import { executeRequest } from "../src/runtime.mjs";
import http from "node:http";

test("modern request shortcuts stringify values and retain legacy apt null semantics", async () => {
  for (const scriptDialect of ["legacy", "apipost8"]) {
    const result = await runScript(
      `
      pm.setRequestHeader('X-Null',null);pm.setRequestHeader('x-zero',0);
      pm.setRequestQuery('q',false);pm.removeRequestQuery('drop');pm.removeRequestHeader('DROP');
      apt.setRequestHeader('x-apt',null);
    `,
      {
        variables: {},
        request: {
          scriptDialect,
          url: "http://localhost/?q=old&drop=1&keep=a%2Bb#fragment",
          headers: [{ key: "drop", value: "old" }],
          query: [],
        },
      },
    );
    assert.equal(result.request.url, "http://localhost/?keep=a%2Bb#fragment");
    assert.deepEqual(result.request.query, [
      { key: "q", value: "false", enabled: true },
    ]);
    assert.equal(
      result.request.headers.find((x) => x.key === "X-Null").value,
      "null",
    );
    assert.equal(
      result.request.headers.find((x) => x.key === "x-zero").value,
      "0",
    );
    assert.equal(
      result.request.headers.find((x) => x.key === "x-apt").value,
      scriptDialect === "legacy" ? "" : "null",
    );
    assert(!result.request.headers.some((x) => x.key.toLowerCase() === "drop"));
  }
});
test("modern shortcuts reach real HTTP without changing the saved request", async (t) => {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ url: req.url, headers: req.headers }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const request = {
    url: `http://127.0.0.1:${server.address().port}/?q=old&keep=yes`,
    scriptDialect: "apipost8",
    beforeScript:
      "pm.setRequestQuery('q','中文');apt.setRequestHeader('x-marker',false);",
  };
  const plan = snapshotPlan({ steps: [{ request }] });
  const before = structuredClone(plan);
  const run = await runPlan(plan, {}, executeRequest);
  assert.equal(run.status, "passed");
  const wire = JSON.parse(run.results[0].response.body);
  assert.equal(
    new URL(wire.url, "http://localhost").searchParams.get("q"),
    "中文",
  );
  assert.equal(wire.headers["x-marker"], "false");
  assert.deepEqual(plan, before);
});
