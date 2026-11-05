import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import http2 from "node:http2";
import { encode } from "@msgpack/msgpack";
import { executeRequest } from "../src/runtime.mjs";

for (const httpVersion of ["1.1", "2"])
  for (const redirect of [undefined, { mode: "same-origin" }])
    test(`HTTP/${httpVersion}: MessagePack selection uses media subtype (${redirect ? "redirect" : "ordinary"})`, async (t) => {
      const textBody = "Hello, 世界!";
      const decoded = { message: "Hello, 世界!" };
      let contentType, body;
      const server = (httpVersion === "2" ? http2 : http).createServer(
        (req, res) => {
          if (redirect && req.url === "/") {
            res.writeHead(302, { location: "/final" });
            res.end();
            return;
          }
          res.writeHead(200, { "content-type": contentType });
          res.end(body);
        },
      );
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      t.after(async () => {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
      });
      const request = () =>
        executeRequest({
          url: `http://127.0.0.1:${server.address().port}/`,
          httpVersion,
          redirect,
        });
      for (contentType of [
        'text/plain; note="msgpack"',
        "application/json; profile=msgpack",
        "application/notmsgpack",
        "application/msgpack-extra",
        "application/msgpack+json",
      ]) {
        body = Buffer.from(textBody);
        const response = await request();
        assert.equal(response.body, textBody, contentType);
        assert.equal(response.codecError, undefined);
        assert.equal(response.rawBodyBase64, undefined);
        assert.equal(response.headers["content-type"], contentType);
        assert.equal(response.size, body.length);
      }
      for (contentType of [
        "application/msgpack",
        "application/vnd.msgpack",
        "Application/X-MsgPack; version=1",
        "application/vnd.example+msgpack",
      ]) {
        body = Buffer.from(encode(decoded));
        const response = await request();
        assert.deepEqual(JSON.parse(response.body), decoded, contentType);
        assert.equal(response.codecError, undefined);
        assert.equal(response.rawBodyBase64, body.toString("base64"));
        assert.equal(response.headers["content-type"], contentType);
        assert.equal(response.size, body.length);
      }
      contentType = "application/msgpack";
      body = Buffer.from([0xc1]);
      const response = await request();
      assert.ok(response.codecError);
      assert.equal(response.body, body.toString("base64"));
      assert.equal(response.rawBodyBase64, body.toString("base64"));
    });
