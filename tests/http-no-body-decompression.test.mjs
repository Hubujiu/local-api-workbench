import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import http2 from "node:http2";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { responseContentDecoder } from "../src/http-response-content.mjs";
import { executeRequest } from "../src/runtime.mjs";
import { readResponseHeaderEvidence } from "../src/response-header-evidence.mjs";
import { readHttpRedirectFailure } from "../src/http-redirect.mjs";

const codecs = { gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync };
const redirect = { mode: "same-origin" };
async function serve(t, version, handler) {
  const seen = [],
    sockets = new Set();
  const server = version === "2" ? http2.createServer() : http.createServer();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("request", (req, res) => {
    seen.push({ method: req.method, url: req.url });
    req.resume();
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}
function evidence(response, encoding) {
  assert.equal(response.headers["content-encoding"], encoding);
  assert.equal(response.headers["x-evidence"], "fictional");
  const raw = readResponseHeaderEvidence(response);
  assert.equal(raw.complete, true);
  assert.equal(raw.counts["content-encoding"], 1);
}
for (const version of ["1.1", "2"]) {
  for (const following of [false, true]) {
    const label = `HTTP/${version} ${following ? "redirect-enabled" : "direct"}`;
    const options = {
      httpVersion: version,
      ...(following ? { redirect } : {}),
    };
    test(`${label}: no-content responses preserve metadata without decoding`, async (t) => {
      const { url } = await serve(t, version, (req, res) => {
        const [, status, encoding] = req.url.split("/");
        res.writeHead(Number(status), {
          "content-encoding": encoding,
          "x-evidence": "fictional",
          ...(req.method === "HEAD" || status === "304"
            ? { "content-length": "12345" }
            : {}),
        });
        res.end();
      });
      for (const encoding of Object.keys(codecs))
        for (const [method, status] of [
          ["HEAD", 200],
          ["HEAD", 404],
          ["GET", 204],
          ["GET", 304],
        ]) {
          const response = await executeRequest({
            ...options,
            method,
            url: `${url}/${status}/${encoding}`,
          });
          assert.equal(response.status, status);
          assert.equal(response.protocol, version === "2" ? "2.0" : "1.1");
          assert.equal(response.body, "");
          assert.equal(response.size, 0);
          evidence(response, encoding);
          if (method === "HEAD" || status === 304)
            assert.equal(response.headers["content-length"], "12345");
        }
    });
    test(`${label}: real encoded bytes decode; empty and corrupt gzip still fail`, async (t) => {
      const text = "fictional 响应 bytes";
      const { url } = await serve(t, version, (req, res) => {
        const [, encoding, mode] = req.url.split("/");
        res.writeHead(mode === "205" ? 205 : 200, {
          "content-encoding": encoding,
          "x-evidence": "fictional",
        });
        res.end(
          mode === "empty" || mode === "205"
            ? undefined
            : mode === "bad"
              ? Buffer.from("not gzip")
              : codecs[encoding](text),
        );
      });
      for (const encoding of Object.keys(codecs)) {
        const response = await executeRequest({
          ...options,
          url: `${url}/${encoding}/valid`,
        });
        assert.equal(response.body, text);
        assert.equal(response.size, Buffer.byteLength(text));
        evidence(response, encoding);
      }
      for (const mode of ["empty", "bad", "205"])
        await assert.rejects(
          executeRequest({ ...options, url: `${url}/gzip/${mode}` }),
          (error) =>
            following
              ? readHttpRedirectFailure(error)?.failure.reason === "transport"
              : /gzip|header|unexpected end/i.test(error.message),
        );
      const empty = await executeRequest({
        ...options,
        url: `${url}/identity/205`,
      });
      assert.equal(empty.status, 205);
      assert.equal(empty.size, 0);
    });
    test(`${label}: informational headers do not suppress final gzip`, async (t) => {
      const { url } = await serve(t, version, (_req, res) => {
        res.writeEarlyHints({
          link: "</fictional>; rel=preload",
          "content-encoding": "gzip",
        });
        res.writeHead(200, { "content-encoding": "gzip" });
        res.end(gzipSync("final"));
      });
      const response = await executeRequest({ ...options, url });
      assert.equal(response.status, 200);
      assert.equal(response.body, "final");
    });
  }
  test(`HTTP/${version}: redirect decoding uses each actual method`, async (t) => {
    const { url, seen } = await serve(t, version, (req, res) => {
      if (req.url.startsWith("/start/")) {
        res.writeHead(Number(req.url.split("/")[2]), {
          location: "/final",
          "content-encoding": "gzip",
        });
        res.end(req.method === "HEAD" ? undefined : gzipSync("hop"));
      } else {
        res.writeHead(200, {
          "content-encoding": "gzip",
          "x-evidence": "fictional",
        });
        res.end(req.method === "HEAD" ? undefined : gzipSync("final"));
      }
    });
    for (const [method, status, finalMethod] of [
      ["HEAD", 302, "HEAD"],
      ["HEAD", 303, "HEAD"],
      ["POST", 302, "GET"],
      ["POST", 303, "GET"],
      ["POST", 307, "POST"],
    ]) {
      const response = await executeRequest({
        url: `${url}/start/${status}`,
        method,
        httpVersion: version,
        redirect,
      });
      assert.deepEqual(
        seen.slice(-2).map((r) => r.method),
        [method, finalMethod],
      );
      assert.deepEqual(
        response.redirectTrace.map((r) => r.method),
        [method, finalMethod],
      );
      assert.equal(response.body, finalMethod === "HEAD" ? "" : "final");
      assert.equal(response.size, finalMethod === "HEAD" ? 0 : 5);
      evidence(response, "gzip");
    }
  });
}

for (const version of ["1.1", "2"])
  for (const following of [false, true]) {
    const options = {
      httpVersion: version,
      ...(following ? { redirect } : {}),
    };
    const label = `HTTP/${version} ${following ? "redirect-enabled" : "direct"}`;
    test(`${label}: cancellation before HEAD headers closes the connection`, async (t) => {
      let arrive, closed;
      const arrived = new Promise((resolve) => (arrive = resolve));
      const disconnected = new Promise((resolve) => (closed = resolve));
      const { url, seen } = await serve(t, version, (req, _res) => {
        req.socket.once("close", closed);
        arrive();
      });
      const controller = new AbortController();
      const pending = executeRequest(
        { ...options, method: "HEAD", url, timeout: 2000 },
        controller.signal,
      );
      const rejected = assert.rejects(pending, (error) =>
        following
          ? readHttpRedirectFailure(error)?.failure.reason === "cancelled"
          : /abort|取消/i.test(error.message),
      );
      await arrived;
      controller.abort();
      await rejected;
      await disconnected;
      assert.equal(seen.length, 1);
    });
    test(`${label}: interrupted gzip remains an error and releases the socket`, async (t) => {
      let closed;
      const disconnected = new Promise((resolve) => (closed = resolve));
      const { url } = await serve(t, version, (req, res) => {
        req.socket.once("close", closed);
        res.writeHead(200, {
          "content-encoding": "gzip",
          "content-length": "1000",
        });
        res.write(gzipSync("fictional").subarray(0, 10));
        setTimeout(() => res.destroy(), 10);
      });
      await assert.rejects(
        executeRequest({ ...options, url, timeout: 2000 }),
        (error) =>
          following
            ? readHttpRedirectFailure(error)?.failure.reason === "transport"
            : /abort|interrupt|protocol|unexpected|stream/i.test(error.message),
      );
      await disconnected;
    });
    test(`${label}: decoded gzip size limits remain enforced`, async (t) => {
      const { url } = await serve(t, version, (_req, res) => {
        res.writeHead(200, { "content-encoding": "gzip" });
        res.end(gzipSync(Buffer.alloc(8 * 1024 * 1024 + 1, 65)));
      });
      await assert.rejects(executeRequest({ ...options, url }), (error) =>
        following
          ? readHttpRedirectFailure(error)?.failure.reason === "response-budget"
          : /8 MiB/.test(error.message),
      );
    });
  }

test("CONNECT remains unsupported before either transport opens a socket", async (t) => {
  const { url, seen } = await serve(t, "1.1", (_req, res) => res.end());
  for (const httpVersion of ["1.1", "2"])
    for (const policy of [undefined, redirect])
      await assert.rejects(
        executeRequest({
          url,
          method: "CONNECT",
          httpVersion,
          redirect: policy,
        }),
        /不支持的 HTTP 方法/,
      );
  assert.equal(seen.length, 0);
});

for (const version of ["1.1", "2"]) {
  test(`HTTP/${version}: redirected 204/304 and malformed final gzip retain their semantics`, async (t) => {
    const { url, seen } = await serve(t, version, (req, res) => {
      if (req.url.startsWith("/start/")) {
        res.writeHead(303, {
          location: req.url.replace("/start", ""),
          "content-encoding": "gzip",
        });
        res.end(gzipSync("hop"));
      } else {
        const status = Number(req.url.slice(1));
        res.writeHead(status, {
          "content-encoding": "gzip",
          "x-evidence": "fictional",
        });
        res.end();
      }
    });
    for (const status of [204, 304]) {
      const result = await executeRequest({
        url: `${url}/start/${status}`,
        method: "POST",
        httpVersion: version,
        redirect,
      });
      assert.equal(result.status, status);
      assert.equal(result.size, 0);
      assert.equal(result.body, "");
      evidence(result, "gzip");
      assert.deepEqual(
        result.redirectTrace.map((row) => row.method),
        ["POST", "GET"],
      );
    }
    await assert.rejects(
      executeRequest({
        url: `${url}/start/200`,
        method: "POST",
        httpVersion: version,
        redirect,
      }),
      (error) => {
        const data = readHttpRedirectFailure(error);
        assert.equal(data.failure.reason, "transport");
        assert.equal(data.response.status, 200);
        assert.equal(data.response.headers["content-encoding"], "gzip");
        return true;
      },
    );
    assert.equal(seen.length, 6);
  });
}

test("decoder selection distinguishes no content from zero-length content", () => {
  for (const encoding of Object.keys(codecs)) {
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
  assert.equal(responseContentDecoder("GET", 200, "identity"), null);
});
