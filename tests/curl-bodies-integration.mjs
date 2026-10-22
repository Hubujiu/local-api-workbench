// Only fixed loopback fixtures are executed. Imported user commands are never run.
import http from "node:http";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { importCurl, toCurl } from "../src/core.mjs";
import { executeRequest } from "../src/runtime.mjs";
import { curlBodyCases, quoteCurl } from "./fixtures/curl-bodies.mjs";
import { curlQueryCases } from "./fixtures/curl-queries.mjs";
const exec = promisify(execFile);
const server = http.createServer((q, r) => {
  let body = "";
  q.on("data", (b) => (body += b));
  q.on("end", () =>
    r.end(
      JSON.stringify({
        body,
        url: q.url,
        method: q.method,
        contentType: q.headers["content-type"] ?? null,
        accept: q.headers.accept ?? null,
      }),
    ),
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
try {
  const origin = "http://127.0.0.1:" + server.address().port;
  for (const fixture of [...curlBodyCases, ...curlQueryCases]) {
    const url = origin + (fixture.path || "/bodies");
    const { stdout } = await exec(
      "curl",
      [
        "--disable",
        "--noproxy",
        "*",
        "--silent",
        "--max-time",
        "3",
        ...fixture.args,
        url,
      ],
      { timeout: 5000, maxBuffer: 262144 },
    );
    const command =
      "curl " +
      (fixture.syntax ?? fixture.args.map(quoteCurl).join(" ")) +
      " " +
      quoteCurl(url);
    if (fixture.ambiguousLeadingEmpty) {
      const wire = JSON.parse(stdout);
      assert(
        ["a=1", "&a=1"].includes(wire.body),
        "only the two observed curl empty-prefix behaviors are recognized",
      );
      assert.throws(
        () => importCurl(command),
        /空片段.*版本/,
        "unknown source curl version must not silently choose either body",
      );
      console.log("CURL_EMPTY_PREFIX_REJECTED", JSON.stringify(wire.body));
      continue;
    }
    if (fixture.queryPath)
      assert.equal(
        JSON.parse(stdout).url,
        fixture.queryPath,
        "native curl exact query path",
      );
    const request = importCurl(command);
    const actual = JSON.parse((await executeRequest(request)).body);
    assert.deepEqual(actual, JSON.parse(stdout), JSON.stringify(fixture.args));
    if (fixture.syntax) {
      const quoted = await exec(
        "sh",
        [
          "-c",
          "curl --disable --noproxy '*' --silent --max-time 3 " +
            fixture.syntax +
            " " +
            quoteCurl(url),
        ],
        { timeout: 5000, maxBuffer: 262144 },
      );
      assert.deepEqual(
        JSON.parse(quoted.stdout),
        actual,
        "fixed literal shell quoting",
      );
    }
    const exported = await exec("sh", ["-c", toCurl(request)], {
      timeout: 5000,
      maxBuffer: 262144,
    });
    assert.deepEqual(
      JSON.parse(exported.stdout),
      actual,
      "exported fixed fixture",
    );
  }
  console.log("CURL_LITERAL_BODY_IMPORT_AND_EXPORT_PASSED");
} finally {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
