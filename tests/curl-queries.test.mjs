import test from "node:test";
import assert from "node:assert/strict";
import { importCurl, toCurl } from "../src/core.mjs";
import { executeRequest } from "../src/runtime.mjs";
import http from "node:http";
import { quoteCurl } from "./fixtures/curl-bodies.mjs";
import { curlQueryCases } from "./fixtures/curl-queries.mjs";
test("cURL query options preserve explicit methods, exact encoded query text and body/header separation over real HTTP", async (t) => {
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (part) => (body += part));
    request.on("end", () =>
      response.end(
        JSON.stringify({
          url: request.url,
          method: request.method,
          body,
          contentType: request.headers["content-type"] ?? null,
          accept: request.headers.accept ?? null,
        }),
      ),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = "http://127.0.0.1:" + server.address().port;
  for (const f of curlQueryCases) {
    const r = importCurl(
      "curl " +
        f.args.map(quoteCurl).join(" ") +
        " " +
        quoteCurl(origin + f.path),
    );
    const url = new URL(r.url);
    assert.equal(
      url.pathname + url.search,
      f.queryPath,
      JSON.stringify(f.args),
    );
    assert.equal(r.method, f.method);
    assert.equal(r.body, f.body);
    assert.equal(r.bodyType, f.body ? "raw" : "none");
    const header = (name) =>
      r.headers.find((h) => h.enabled !== false && h.key.toLowerCase() === name)
        ?.value ?? null;
    assert.equal(header("content-type"), f.contentType ?? null);
    assert.equal(header("accept"), f.accept ?? "*/*");
    for (const candidate of [r, importCurl(toCurl(r))])
      assert.deepEqual(JSON.parse((await executeRequest(candidate)).body), {
        url: f.queryPath,
        method: f.method,
        body: f.body,
        contentType: f.contentType ?? null,
        accept: f.accept ?? "*/*",
      });
  }
});
test("cURL query import refuses files, ambiguous mixed switches and unencoded or over-budget fragments", () => {
  for (const args of [
    ["-G", "-d", ""],
    ["-G", "-d", "q=a b"],
    ["-G", "-d", "q=a#b"],
    ["-G", "-d", "q=中文"],
    ["-G", "-d", "q=%ZZ"],
    ["--url-query", "+q=%"],
    ["--url-query", "+q=中文"],
    ["--url-query", ""],
    ["--url-query", "@file"],
    ["--url-query", "name@file"],
    ["-G", "--url-query", "a=1"],
    ["-G", "-F", "a=1"],
    ["--url-query", "q=" + "x".repeat(65536)],
    ["--url-query", "q=" + "中".repeat(10000)],
    Array.from({ length: 3 }, () => [
      "--url-query",
      "q=" + "x".repeat(30000),
    ]).flat(),
    Array.from({ length: 1001 }, () => ["--url-query", "q=1"]).flat(),
  ])
    assert.throws(() =>
      importCurl(
        "curl " + args.map(quoteCurl).join(" ") + " http://example.test",
      ),
    );
});
