import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { importCurl, toCurl } from "../src/core.mjs";
import { executeRequest } from "../src/runtime.mjs";
import { generateRequestCode } from "../src/request-code-generation.mjs";

const exec = promisify(execFile);
const base = {
  url: "http://127.0.0.1:1/",
  method: "POST",
  bodyType: "form-data",
  form: [],
  timeout: 2000,
};
function checkEmpty(wire) {
  const boundary = /^multipart\/form-data; boundary=([A-Za-z0-9-]{48})$/.exec(
    wire.type,
  )?.[1];
  assert.ok(boundary, wire.type);
  assert.equal(wire.body, `--${boundary}--\r\n`);
  assert.equal(wire.length, "54");
  assert.equal(Buffer.byteLength(wire.body), 54);
  assert.equal(wire.method, "POST");
  assert.equal(wire.typeCount, 1);
  assert.equal(wire.lengthCount, 1);
  assert.equal(wire.transfer, undefined);
}

test(
  "empty and all-disabled multipart curl preserves zero-part framing over POSIX shell and JSON serialization",
  {
    skip:
      process.platform === "win32"
        ? "Generated commands target POSIX shell, not Windows shells"
        : false,
  },
  async (t) => {
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      res.end(
        JSON.stringify({
          body: Buffer.concat(chunks).toString("utf8"),
          type: req.headers["content-type"],
          length: req.headers["content-length"],
          transfer: req.headers["transfer-encoding"],
          method: req.method,
          url: req.url,
          marker: req.headers["x-marker"],
          auth: req.headers["x-auth"],
          typeCount: req.rawHeaders.filter(
            (x, i) => i % 2 === 0 && x.toLowerCase() === "content-type",
          ).length,
          lengthCount: req.rawHeaders.filter(
            (x, i) => i % 2 === 0 && x.toLowerCase() === "content-length",
          ).length,
        }),
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    for (const form of [
      [],
      [{ key: "ignored='中\\\r\n", value: "@ignored", enabled: false }],
    ]) {
      for (const auth of [
        { type: "none" },
        { type: "apiKey", in: "header", key: "x-auth", value: "test" },
      ]) {
        const request = {
          ...base,
          url: `http://127.0.0.1:${server.address().port}/empty?encoded=%E4%B8%AD&x=%2f`,
          form,
          auth,
          headers: [
            { key: "CoNtEnT-TyPe", value: "wrong/header" },
            { key: "CONTENT-length", value: "999" },
            { key: "x-marker", value: "it's \\ literal" },
            { key: "Transfer-Encoding", value: "chunked", enabled: false },
          ],
        };
        const before = structuredClone(request);
        const command = JSON.parse(JSON.stringify(toCurl(request)));
        assert.match(command, /--data-binary/);
        assert.ok(command.endsWith("\r\n'"));
        assert.doesNotMatch(command, /--form-string/);
        const runtime = JSON.parse((await executeRequest(request)).body);
        // Only generated commands for fixed loopback fixtures are executed.
        const curl = JSON.parse(
          (await exec("sh", ["-c", command], { timeout: 5000 })).stdout,
        );
        for (const wire of [runtime, curl]) {
          checkEmpty(wire);
          assert.equal(wire.url, "/empty?encoded=%E4%B8%AD&x=%2f");
          assert.equal(wire.marker, "it's \\ literal");
          assert.equal(wire.auth, auth.type === "apiKey" ? "test" : undefined);
        }
        assert.notEqual(
          runtime.type,
          curl.type,
          "boundary identity is intentionally not a byte-for-byte runtime match",
        );
        const imported = importCurl(command);
        assert.equal(
          imported.bodyType,
          "raw",
          "import preserves literal bytes, not an editable multipart definition",
        );
        assert.equal(imported.body, curl.body);
        checkEmpty(JSON.parse((await executeRequest(imported)).body));
        assert.deepEqual(request, before);
      }
    }
  },
);

test("empty multipart rejects ambiguous framing after auth and retains existing export restrictions", () => {
  for (const key of [
    "content-type",
    "Content-Type",
    "CONTENT-LENGTH",
    "content-length",
  ]) {
    assert.throws(
      () =>
        toCurl({
          ...base,
          auth: { type: "apiKey", in: "header", key, value: "wrong" },
        }),
      /API-key/,
    );
  }
  for (const key of ["Transfer-Encoding", "tRaIlEr"]) {
    assert.throws(
      () => toCurl({ ...base, headers: [{ key, value: "chunked" }] }),
      /空 multipart/,
    );
    assert.throws(
      () =>
        toCurl({
          ...base,
          auth: { type: "apiKey", in: "header", key, value: "chunked" },
        }),
      /空 multipart/,
    );
  }
  for (const type of ["aws", "oauth1", "jwt", "hawk", "asap", "edgegrid"])
    assert.throws(() => toCurl({ ...base, auth: { type } }));
  for (const enabled of [true, false])
    assert.throws(
      () =>
        toCurl({
          ...base,
          form: [{ key: "file", type: "file", value: "", enabled }],
        }),
      /文件/,
    );
  assert.throws(
    () =>
      toCurl({
        ...base,
        form: [
          { key: "x", value: "", enabled: false, contentType: "text/plain" },
        ],
      }),
    /Content-Type/,
  );
  for (const [target, client] of [
    ["node", "fetch"],
    ["python", "python3"],
    ["go", "native"],
  ])
    assert.throws(() => generateRequestCode(base, target, client), /multipart/);
  const nonempty = toCurl({
    ...base,
    form: [{ key: "safe", value: "@literal;'中" }],
  });
  assert.match(nonempty, /--form-string/);
  assert.doesNotMatch(nonempty, /--data-binary|boundary=|content-length/);
});
