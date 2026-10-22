import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { importCurl, toCurl } from "../src/core.mjs";
import { executeRequest } from "../src/runtime.mjs";
import { curlBodyCases, quoteCurl } from "./fixtures/curl-bodies.mjs";

test("literal cURL bodies preserve concatenation, encoding, headers and explicit method over real HTTP", async (t) => {
  const server = http.createServer((q, r) => {
    let body = "";
    q.on("data", (b) => (body += b));
    q.on("end", () =>
      r.end(
        JSON.stringify({
          body,
          method: q.method,
          contentType: q.headers["content-type"] ?? null,
          accept: q.headers.accept ?? null,
        }),
      ),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = "http://127.0.0.1:" + server.address().port;
  for (const fixture of curlBodyCases) {
    if (fixture.ambiguousLeadingEmpty) {
      assert.throws(
        () =>
          importCurl(
            "curl " +
              fixture.args.map(quoteCurl).join(" ") +
              " " +
              quoteCurl(url),
          ),
        /空片段.*版本/,
      );
      continue;
    }
    const request = importCurl(
      "curl " +
        (fixture.syntax ?? fixture.args.map(quoteCurl).join(" ")) +
        " " +
        quoteCurl(url),
    );
    const expected = {
      body: fixture.body,
      method: fixture.method ?? "POST",
      contentType:
        fixture.contentType === undefined
          ? "application/x-www-form-urlencoded"
          : fixture.contentType,
      accept: fixture.accept === undefined ? "*/*" : fixture.accept,
    };
    for (const candidate of [request, importCurl(toCurl(request))])
      assert.deepEqual(
        JSON.parse((await executeRequest(candidate)).body),
        expected,
        JSON.stringify(fixture.args),
      );
  }
});

test("cURL import refuses nonliteral shell expansion and command operators without executing them", () => {
  for (const fragment of [
    '--data-raw "$HOME"',
    '--data-raw "$(printf hi)"',
    '--data-raw "`printf hi`"',
    "--data-raw $'a\\n'",
    "--data-raw x; echo y",
    "--data-raw x | cat",
    "--data-raw x > out",
    "--data-raw #comment",
  ])
    assert.throws(
      () => importCurl("curl http://localhost " + fragment),
      /Shell/,
    );
  assert.equal(
    importCurl('curl http://localhost --data-raw "cost $"').body,
    "cost $",
  );
});

test("cURL rejects file input and incompatible body families rather than changing their meaning", () => {
  for (const args of [
    ["--json", "@private"],
    ["--data-binary", "@-"],
    ["--data-urlencode", "name@private"],
    ["--data-urlencode", "@private"],
  ])
    assert.throws(
      () =>
        importCurl("curl http://localhost " + args.map(quoteCurl).join(" ")),
      /不自动读取/,
    );
  for (const args of [
    ["--json", "{}", "-d", "x=1"],
    ["-d", "a=1", "-F", "b=2"],
    ["-F", "a=1", "--data-raw", "b=2"],
  ])
    assert.throws(
      () =>
        importCurl("curl http://localhost " + args.map(quoteCurl).join(" ")),
      /混用/,
    );
  assert.throws(() => importCurl("curl http://localhost --data"), /缺少/);
});
