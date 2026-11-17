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
test("Cookie encoding is explicit and snapshots preserve the selected policy", () => {
  assert.equal(normalizeRequest({}).cookieEncoding, "raw");
  assert.equal(
    snapshotPlan({ steps: [{ request: { cookieEncoding: "apipost-name" } }] })
      .steps[0].request.cookieEncoding,
    "apipost-name",
  );
  for (const cookieEncoding of [true, 1, null, "unknown"])
    assert.throws(() => normalizeRequest({ cookieEncoding }), /Cookie/);
  assert.throws(
    () =>
      exportOpenAPI({
        requests: [
          {
            url: "https://example.test",
            method: "GET",
            cookieEncoding: "apipost",
            cookies: [{ key: "q", value: "a b" }],
          },
        ],
      }),
    /Cookie/,
  );
});
test("Cookie encoding preserves existing escapes, duplicate order and actual HTTP1/2 plus cURL wire", async (t) => {
  for (const version of ["1.1", "2"]) {
    const server = version === "2" ? http2.createServer() : http.createServer();
    server.on("request", (req, res) =>
      res.end(JSON.stringify({ cookie: req.headers.cookie ?? null })),
    );
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => new Promise((r) => server.close(r)));
    const request = {
      url: "http://127.0.0.1:" + server.address().port,
      httpVersion: version,
      cookieEncoding: "apipost",
      cookies: [
        { key: "空 格", value: "中 文+&=" },
        { key: "escaped", value: "a%20b" },
        { key: "escaped", value: "100%" },
        { key: "zero", value: 0 },
        { key: "off", value: "not sent", enabled: false },
      ],
    };
    const before = structuredClone(request),
      wire = JSON.parse((await executeRequest(request)).body);
    assert.equal(
      wire.cookie,
      "%E7%A9%BA%20%E6%A0%BC=%E4%B8%AD%20%E6%96%87%2B%26%3D; escaped=a%20b; escaped=100%25; zero=0",
    );
    if (version === "1.1")
      assert.deepEqual(
        JSON.parse((await executeRequest(importCurl(toCurl(request)))).body),
        wire,
      );
    assert.deepEqual(request, before);
    const names = JSON.parse(
      (
        await executeRequest({
          ...request,
          cookieEncoding: "apipost-name",
          cookies: [{ key: "space key", value: "raw+value%20" }],
        })
      ).body,
    );
    assert.equal(names.cookie, "space%20key=raw+value%20");
    const raw = JSON.parse(
      (
        await executeRequest({
          ...request,
          cookieEncoding: "raw",
          cookies: [{ key: "plain", value: "a+b%20" }],
        })
      ).body,
    );
    assert.equal(raw.cookie, "plain=a+b%20");
  }
});
