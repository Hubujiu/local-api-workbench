import test from "node:test";
import assert from "node:assert/strict";
import { runScript } from "../src/scripts.mjs";
test("query shortcuts ignore URL delimiters inside unresolved template names", async () => {
  const url = "http://{{host?x}}:{{port#x}}/p?drop=1&q={{v&x}}#{{fragment#id}}";
  const result = await runScript(
    "pm.removeRequestQuery('drop');pm.setRequestQuery('added','yes');",
    { variables: {}, request: { url, query: [] } },
  );
  assert.equal(
    result.request.url,
    "http://{{host?x}}:{{port#x}}/p?q={{v&x}}#{{fragment#id}}",
  );
  assert.deepEqual(result.request.query, [
    { key: "added", value: "yes", enabled: true },
  ]);
});
test("batch removal keeps placeholder values whole and retains untouched raw URI spelling", async () => {
  const url =
    "https://{{host#part}}/p?q={{v&x}}&keep=a%2Bb&keep=two#{{frag?x}}";
  const result = await runScript("pm.request.removeQueryParams('q');", {
    variables: {},
    request: { url, query: [] },
  });
  assert.equal(
    result.request.url,
    "https://{{host#part}}/p?keep=a%2Bb&keep=two#{{frag?x}}",
  );
  const unchanged = await runScript(
    "pm.request.removeQueryParams('missing');",
    { variables: {}, request: { url, query: [] } },
  );
  assert.equal(unchanged.request.url, url);
});

test("literal query changes preserve unusual variable names through actual interpolation and HTTP", async (t) => {
  const http = await import("node:http");
  const { runPlan, snapshotPlan } = await import("../src/core.mjs");
  const { executeRequest } = await import("../src/runtime.mjs");
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ url: req.url }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const variables = {
    "host?x": "127.0.0.1",
    "port#x": String(server.address().port),
    "value&x": "kept",
    "frag#x": "ignored",
  };
  const plan = snapshotPlan({
    steps: [
      {
        request: {
          url: "http://{{host?x}}:{{port#x}}/p?drop=old&q={{value&x}}#{{frag#x}}",
          beforeScript:
            "pm.removeRequestQuery('drop');pm.setRequestQuery('safe','中文');pm.request.addQueryParams('added={{value&x}}&encoded=a%2Bb');",
        },
      },
    ],
  });
  const saved = structuredClone(plan),
    result = await runPlan(plan, variables, executeRequest);
  assert.equal(result.status, "passed", JSON.stringify(result));
  const url = new URL(
    JSON.parse(result.results[0].response.body).url,
    "http://localhost",
  );
  assert.equal(url.searchParams.has("drop"), false);
  assert.equal(url.searchParams.get("q"), "kept");
  assert.equal(url.searchParams.get("safe"), "中文");
  assert.equal(url.searchParams.get("added"), "kept");
  assert.equal(url.searchParams.get("encoded"), "a+b");
  assert.deepEqual(plan, saved);
});

test("encoded query additions preserve interpolation names and decode only literal spans", async () => {
  for (const dialect of ["legacy", "apipost8"]) {
    const result = await runScript(
      "pm.request.addQueryParams('q={{v+&=%x}}&q=prefix+{{v+&=%x}}%2Btail&{{key=+&%name}}=literal');",
      {
        variables: {},
        request: {
          scriptDialect: dialect,
          url: "http://localhost/",
          query: [],
        },
      },
    );
    assert.deepEqual(
      result.request.query.map(({ key, value }) => [key, value]),
      [
        ["q", "{{v+&=%x}}"],
        ["q", "prefix {{v+&=%x}}+tail"],
        ["{{key=+&%name}}", "literal"],
      ],
    );
  }
});
