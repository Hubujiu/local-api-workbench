import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { importCurl, toCurl } from "../src/core.mjs";
import { executeRequest } from "../src/runtime.mjs";
import { quoteCurl } from "./fixtures/curl-bodies.mjs";
const exec = promisify(execFile);
const fixtures = [
  ["-G", "-da=1", "-db=2"],
  ["-XPOST", "-HContent-Type: application/json", '-d{"x":1}'],
  [
    "-XPUT",
    "-XPATCH",
    "-HX-Repeat: one",
    "-HX-Repeat: two",
    "-da=1",
    "-d",
    "b=2",
  ],
  ["-dquote='; dollar=$; slash=\\; newline=\n中文"],
  ["-d\nleading newline"],
  ["-d", "-Hliteral", "-d-dliteral", "-HX-Literal: -dvalue"],
  ["-HAccept:", "-HX-Empty;", "-dvalue"],
];
const command = (args, url) =>
  "curl " + [...args, url].map(quoteCurl).join(" ");
function separated(args) {
  const output = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (["-X", "-H", "-d"].includes(arg)) output.push(arg, args[++i]);
    else if (/^-[XHd]/.test(arg)) output.push(arg.slice(0, 2), arg.slice(2));
    else output.push(arg);
  }
  return output;
}
function stable(request) {
  const { id, createdAt, updatedAt, ...rest } = request;
  return rest;
}
test("attached short options reuse separated parsing without reinterpreting values", () => {
  for (const args of fixtures)
    assert.deepEqual(
      stable(importCurl(command(args, "http://localhost"))),
      stable(importCurl(command(separated(args), "http://localhost"))),
    );
  assert.equal(
    importCurl(`curl -X'PO'"ST" -H'X-Test: a' -d'it'\\''s' http://localhost`)
      .body,
    "it's",
  );
  assert.equal(
    importCurl('curl -d"cost \\$5" http://localhost').body,
    "cost $5",
  );
});
test("attached options retain file, shell, unsupported option and body ambiguity refusals", () => {
  for (const fragment of [
    "-d@private",
    "-d@-",
    "-H@private",
    "-Ffield=value",
    "-uuser:pass",
    "-Kconfig",
    "-ooutput",
    "-sXPOST",
    "--request=POST",
    "-d'$(literal)' --json '{}'",
    "-d '' -dx",
  ])
    assert.throws(() => importCurl(`curl http://localhost ${fragment}`));
  for (const fragment of [
    '-d"$HOME"',
    '-d"$(touch forbidden)"',
    '-d"`id`"',
    "-dx; echo y",
    "-dx | cat",
    "-dx > out",
    "-d$'x'",
  ])
    assert.throws(
      () => importCurl(`curl http://localhost ${fragment}`),
      /Shell/,
    );
  // Empty attached quotation is indistinguishable from a separated option;
  // existing missing-value/empty-prefix behavior is retained rather than guessed.
  for (const option of ["-X", "-H", "-d"])
    assert.throws(() => importCurl(`curl http://localhost ${option}`));
});
test("fixed attached-option fixtures match real curl and exported imports on loopback", async (t) => {
  const peer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () =>
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          body,
          contentType: req.headers["content-type"] ?? null,
          accept: req.headers.accept ?? null,
          repeated: req.headers["x-repeat"] ?? null,
          literal: req.headers["x-literal"] ?? null,
          empty: req.headers["x-empty"] ?? null,
        }),
      ),
    );
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
  });
  const url = `http://127.0.0.1:${peer.address().port}/attached`;
  for (const args of fixtures) {
    // Fixed synthetic arguments only, no shell and no imported command execution.
    const { stdout } = await exec(
      "curl",
      [
        "--disable",
        "--noproxy",
        "*",
        "--silent",
        "--max-time",
        "3",
        ...args,
        url,
      ],
      { timeout: 5000, maxBuffer: 262144 },
    );
    const expected = JSON.parse(stdout);
    const imported = importCurl(command(args, url));
    for (const request of [imported, importCurl(toCurl(imported))])
      assert.deepEqual(
        JSON.parse((await executeRequest(request)).body),
        expected,
        JSON.stringify(args),
      );
  }
});
