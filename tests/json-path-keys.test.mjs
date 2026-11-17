import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { jsonPath, runPlan, snapshotPlan } from "../src/core.mjs";
import { executeRequest } from "../src/runtime.mjs";

test("scalar paths support exact quoted names, escapes, array indexes and legacy dotted fields", () => {
  const data = {
    "a.b": [
      {
        "field name": false,
        "": 0,
        "a'b": 1,
        'a"b': 2,
        "slash\\key": 3,
        "🙂": 4,
      },
    ],
    plain: { x: 5 },
  };
  assert.equal(jsonPath(data, '$["a.b"][0]["field name"]'), false);
  assert.equal(jsonPath(data, "$['a.b'][0]['']"), 0);
  assert.equal(jsonPath(data, String.raw`$['a.b'][0]['a\'b']`), 1);
  assert.equal(jsonPath(data, String.raw`$['a.b'][0]["a\"b"]`), 2);
  assert.equal(jsonPath(data, String.raw`$["a\u002eb"][ 0 ]["slash\\key"]`), 3);
  assert.equal(jsonPath(data, String.raw`$['a.b'][0]['\uD83D\uDE42']`), 4);
  assert.equal(jsonPath(data, "$['a.b'][0]['🙂']"), 4);
  assert.equal(jsonPath(data, "plain.x"), 5);
  assert.equal(jsonPath(data, "$.missing"), undefined);
  assert.equal(jsonPath(data, "$"), data);
  assert.equal(jsonPath(data, ""), data);
});

test("paths reject unsupported expressions, unsafe names, malformed strings and excessive work", () => {
  for (const path of [
    "$..name",
    "$.*",
    "$[?(@.x)]",
    "$[-1]",
    "$[1:3]",
    "$[0,1]",
    "$[01]",
    "$[9007199254740992]",
    '$["x"]junk',
    "$.a.",
    "$.a[",
    String.raw`$["bad\q"]`,
    String.raw`$['\uD800']`,
    String.raw`$['\uDC00']`,
    String.raw`$['\uD800\u0041']`,
    String.raw`$["a\'b"]`,
    String.raw`$['a\"b']`,
  ])
    assert.throws(() => jsonPath({}, path), /JSON 路径/);
  for (const name of ["__proto__", "constructor", "prototype"])
    assert.throws(() => jsonPath({}, `$.missing["${name}"]`), /禁止/);
  assert.throws(() => jsonPath({}, String.raw`$["__pro\u0074o__"]`), /禁止/);
  assert.throws(() => jsonPath({}, "a".repeat(4097)), /上限/);
  assert.throws(() => jsonPath({}, Array(65).fill("a").join(".")), /上限/);
  assert.equal(jsonPath(Object.create({ hidden: 1 }), "hidden"), undefined);
});

test("quoted-key response extraction reaches the next real HTTP plan step", async (t) => {
  const seen = [];
  const server = http.createServer((q, r) => {
    seen.push(q.url);
    r.setHeader("content-type", "application/json");
    r.end(
      JSON.stringify({
        data: { "token.value": [{ "field name": "quoted-token" }] },
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = "http://127.0.0.1:" + server.address().port;
  const plan = snapshotPlan({
    steps: [
      {
        request: {
          url,
          extract: [
            {
              name: "token",
              source: "json",
              path: `$.data['token.value'][0]["field name"]`,
            },
          ],
        },
      },
      { request: { url: url + "/{{token}}" } },
    ],
  });
  const result = await runPlan(plan, {}, executeRequest);
  assert.equal(result.status, "passed");
  assert.equal(seen[1], "/quoted-token");
});
