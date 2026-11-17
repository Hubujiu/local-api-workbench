import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import http2 from "node:http2";
import { responseContentDecoder } from "../src/http-response-content.mjs";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { executeRequest } from "../src/runtime.mjs";

for (const httpVersion of ["1.1", "2"]) {
  for (const redirect of [undefined, { mode: "same-origin" }]) {
    for (const [encoding, compress] of [
      ["GZip", gzipSync],
      ["DEFLATE", deflateSync],
      ["Br", brotliCompressSync],
    ]) {
      test(`HTTP/${httpVersion}: decodes case-insensitive ${encoding} content coding (${redirect ? "redirect" : "ordinary"})`, async (t) => {
        const body = "Hello, 世界!";
        const server = (httpVersion === "2" ? http2 : http).createServer(
          (req, res) => {
            if (redirect && req.url === "/") {
              res.writeHead(302, { location: "/final" });
              res.end();
              return;
            }
            res.writeHead(200, { "Content-Encoding": encoding });
            res.end(compress(Buffer.from(body)));
          },
        );
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        t.after(async () => {
          server.closeAllConnections?.();
          await new Promise((resolve) => server.close(resolve));
        });
        const response = await executeRequest({
          url: `http://127.0.0.1:${server.address().port}/`,
          httpVersion,
          redirect,
        });
        assert.equal(response.body, body);
        assert.equal(response.size, Buffer.byteLength(body));
        assert.equal(response.headers["content-encoding"], encoding);
      });
    }
  }
}

for (const httpVersion of ["1.1", "2"])
  for (const redirect of [undefined, { mode: "same-origin" }])
    test(`HTTP/${httpVersion}: mixed-case encoding preserves bodyless responses (${redirect ? "redirect" : "ordinary"})`, async (t) => {
      const server = (httpVersion === "2" ? http2 : http).createServer(
        (req, res) => {
          const [, route, status, encoding] = req.url.split("/");
          if (route === "start") {
            res.writeHead(302, { location: `/final/${status}/${encoding}` });
          } else {
            res.writeHead(Number(status), { "content-encoding": encoding });
          }
          res.end();
        },
      );
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      t.after(async () => {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
      });
      for (const encoding of ["GZip", "DEFLATE", "Br"])
        for (const [method, status] of [
          ["HEAD", 200],
          ["HEAD", 404],
          ["GET", 204],
          ["GET", 304],
        ]) {
          const response = await executeRequest({
            url: `http://127.0.0.1:${server.address().port}/${redirect ? "start" : "final"}/${status}/${encoding}`,
            method,
            httpVersion,
            redirect,
          });
          assert.equal(response.status, status);
          assert.equal(response.body, "");
          assert.equal(response.size, 0);
          assert.equal(response.headers["content-encoding"], encoding);
        }
    });

test("mixed-case decoder selection retains no-body exceptions and 205 decoding", () => {
  for (const encoding of ["GZip", "DEFLATE", "Br"]) {
    for (const status of [100, 101, 103, 199, 204, 304])
      assert.equal(responseContentDecoder("GET", status, encoding), null);
    for (const status of [200, 302, 404, 500])
      assert.equal(responseContentDecoder("HEAD", status, encoding), null);
    for (const status of [200, 205, 206, 302, 404, 500]) {
      const decoder = responseContentDecoder("GET", status, encoding);
      assert.ok(decoder);
      decoder.destroy();
    }
  }
  assert.equal(responseContentDecoder("GET", 200, undefined), null);
  assert.equal(responseContentDecoder("GET", 200, "IDENTITY"), null);
});

test("unknown and stacked encodings remain undecoded", () => {
  for (const encoding of ["compress", "CUSTOM", "gzip, br", "GZip, Br"])
    assert.equal(responseContentDecoder("GET", 200, encoding), null);
});
