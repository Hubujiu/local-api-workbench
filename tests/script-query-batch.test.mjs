import test from "node:test";
import assert from "node:assert/strict";
import { runScript } from "../src/scripts.mjs";
const run = (code, request = {}) =>
  runScript(code, {
    variables: {},
    request: { url: "http://localhost/?raw=1#section", query: [], ...request },
  });
test("batch query methods preserve duplicates, decode valid query text once and remove all selected names", async () => {
  const r = await run(
    `pm.request.addQueryParams('q=a%2Bb&q=%E4%B8%AD%E6%96%87');apt.request.addQueryParams([{key:'q',value:'last'},{key:'off',value:'hidden',disabled:true}]);pm.request.removeQueryParams(['raw',{key:'off'}]);`,
  );
  assert.equal(r.request.url, "http://localhost/#section");
  assert.deepEqual(
    r.request.query.map((x) => [x.key, x.value]),
    [
      ["q", "a+b"],
      ["q", "中文"],
      ["q", "last"],
    ],
  );
});
test("batch validation is atomic and rejects ambiguous flag-only and malformed encoded input", async () => {
  for (const value of [
    "flag",
    "?q=1",
    "q=%FF",
    [
      { key: "good", value: "x" },
      { key: "bad", value: {} },
    ],
  ]) {
    const input = {
      url: "http://localhost/?raw=1#section",
      query: [{ key: "keep", value: "old" }],
    };
    const r = await run(
      `try{pm.request.addQueryParams(${JSON.stringify(value)})}catch(e){apt.setVar('rejected',true)}`,
      input,
    );
    assert.equal(r.variables.rejected, true);
    assert.deepEqual(r.request.query, input.query);
    assert.equal(r.request.url, input.url);
  }
});
test("removeQueryParams treats strings as literal names and does not parse a query string", async () => {
  const r = await run(`pm.request.removeQueryParams('a=1');`, {
    url: "http://localhost/?a%3D1=x&a=1#f",
    query: [
      { key: "a=1", value: "second" },
      { key: "a", value: "second" },
    ],
  });
  assert.equal(r.request.url, "http://localhost/?a=1#f");
  assert.deepEqual(r.request.query, [{ key: "a", value: "second" }]);
});

test("combined URL/query bounds and invalid selectors fail without partial changes", async () => {
  const input = {
    url: "http://localhost/?raw=1#f",
    query: [{ key: "first", value: "keep" }],
  };
  const invalid = await run(
    `try{pm.request.removeQueryParams(['first',4])}catch(e){apt.setVar('rejected',true)}`,
    input,
  );
  assert.equal(invalid.variables.rejected, true);
  assert.deepEqual(invalid.request.query, input.query);
  assert.equal(invalid.request.url, input.url);
  const many = {
    url: input.url,
    query: Array.from({ length: 999 }, (_, i) => ({
      key: "k" + i,
      value: "x",
    })),
  };
  const full = await run(
    `try{pm.request.addQueryParams({key:'extra',value:'x'})}catch(e){apt.setVar('rejected',true)}`,
    many,
  );
  assert.equal(full.variables.rejected, true);
  assert.deepEqual(full.request.query, many.query);
  const large = await run(
    `try{pm.request.addQueryParams([{key:'text',value:'中'.repeat(30000)}])}catch(e){apt.setVar('rejected',true)}`,
    input,
  );
  assert.equal(large.variables.rejected, true);
  assert.deepEqual(large.request.query, input.query);
});
test("batch query edits reach real HTTP without double encoding, disabled values or saved-plan mutation", async (t) => {
  const http = await import("node:http");
  const { runPlan, snapshotPlan } = await import("../src/core.mjs");
  const { executeRequest } = await import("../src/runtime.mjs");
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ url: req.url }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const plan = snapshotPlan({
    steps: [
      {
        request: {
          url: "http://127.0.0.1:" + server.address().port + "/?q=raw&drop=old",
          query: [{ key: "q", value: "existing" }],
          beforeScript:
            "pm.request.addQueryParams('q=a%2Bb&q=%E4%B8%AD%E6%96%87');apt.request.addQueryParams([{key:'off',value:'hidden',disabled:true},{key:'__proto__',value:'literal'}]);pm.request.removeQueryParams('drop');",
        },
      },
    ],
  });
  const saved = structuredClone(plan);
  const result = await runPlan(plan, {}, executeRequest);
  assert.equal(result.status, "passed", JSON.stringify(result));
  const url = new URL(
    JSON.parse(result.results[0].response.body).url,
    "http://localhost",
  );
  assert.deepEqual(url.searchParams.getAll("q"), [
    "raw",
    "existing",
    "a+b",
    "中文",
  ]);
  assert.equal(url.searchParams.has("off"), false);
  assert.equal(url.searchParams.has("drop"), false);
  assert.equal(url.searchParams.get("__proto__"), "literal");
  assert.deepEqual(plan, saved);
});
