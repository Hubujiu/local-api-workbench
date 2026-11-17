import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import http2 from "node:http2";
import {
  normalizeRequest,
  snapshotPlan,
  toCurl,
  importCurl,
  exportOpenAPI,
} from "../src/core.mjs";
import { executeRequest } from "../src/runtime.mjs";
test("query equals choice is explicit, typed and preserved by request snapshots", () => {
  assert.equal(normalizeRequest({}).queryAddEqual, true);
  assert.equal(
    snapshotPlan({ steps: [{ request: { queryAddEqual: false } }] }).steps[0]
      .request.queryAddEqual,
    false,
  );
  for (const value of [null, 0, -1, "false", {}])
    assert.throws(() => normalizeRequest({ queryAddEqual: value }), /等号/);
  assert.throws(
    () =>
      exportOpenAPI({
        requests: [
          normalizeRequest({
            url: "https://example.test/",
            queryAddEqual: false,
          }),
        ],
      }),
    /等号/,
  );
});
test("HTTP1/2 and cURL preserve empty flag choice, raw query spelling and query auth additions", async (t) => {
  for (const version of ["1.1", "2"]) {
    const server = version === "2" ? http2.createServer() : http.createServer(),
      sessions = new Set();
    server.on("session", (s) => sessions.add(s));
    server.on("request", (req, res) =>
      res.end(JSON.stringify({ url: req.url })),
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      for (const s of sessions) s.destroy();
      server.close();
    });
    for (const addEqual of [true, false]) {
      const r = {
        url:
          "http://127.0.0.1:" +
          server.address().port +
          "/?rawFlag&raw=a%2Bb#fragment",
        httpVersion: version,
        queryAddEqual: addEqual,
        query: [
          { key: "flag", value: "" },
          { key: "nil", value: null },
          { key: "zero", value: 0 },
          { key: "bool", value: false },
          { key: "off", value: "", enabled: false },
        ],
        auth: { type: "apiKey", in: "query", key: "token", value: "a+b" },
      };
      const expected =
        "/?rawFlag&raw=a%2Bb&flag" +
        (addEqual ? "=" : "") +
        "&nil" +
        (addEqual ? "=" : "") +
        "&zero=0&bool=false&token=a%2Bb";
      assert.equal(JSON.parse((await executeRequest(r)).body).url, expected);
      assert.equal(
        JSON.parse((await executeRequest(importCurl(toCurl(r)))).body).url,
        expected,
      );
    }
  }
});

test("query auth replacement changes matching names only and preserves unrelated raw fields", async () => {
  const { setURLQuery } = await import("../src/query-serialization.mjs");
  const url = new URL(
    "http://localhost/?flag&t%6fken=old&keep=a%20b&token=second#part",
  );
  setURLQuery(url, "token", "a b");
  assert.equal(url.href, "http://localhost/?flag&token=a+b&keep=a%20b#part");
});
test("query equals preference survives split-file save and portable project restore", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Store } = await import("../src/runtime.mjs");
  const { restoreProject } = await import("../src/core.mjs");
  const root = await mkdtemp(join(tmpdir(), "query-equals-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root),
    p = await store.create("Flags");
  p.requests = [
    normalizeRequest({
      url: "http://localhost/",
      queryAddEqual: false,
      query: [{ key: "flag", value: "" }],
    }),
  ];
  await store.save(p);
  const loaded = await store.get(p.id);
  assert.equal(loaded.requests[0].queryAddEqual, false);
  assert.equal(
    restoreProject(JSON.parse(JSON.stringify(loaded))).requests[0]
      .queryAddEqual,
    false,
  );
});
