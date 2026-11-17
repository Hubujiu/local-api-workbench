import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import http2 from "node:http2";
import { readFile } from "node:fs/promises";
import { executeRequest } from "../src/runtime.mjs";
import { verifyOAuth1Policy } from "./fixtures/oauth1-policy-oracle.mjs";
const policy = (placement = "auto") => ({
  placement,
  includeBodyHash: true,
  includeEmptyParams: false,
  headerEncoding: "percent",
});
const auth = (placement = "auto") => ({
  type: "oauth1",
  consumerKey: "wire-key",
  consumerSecret: "wire-secret",
  accessToken: "wire-token",
  tokenSecret: "wire-token-secret",
  version: "1.0",
  signatureMethod: "HMAC-SHA256",
  parameterPolicy: policy(placement),
});
test(
  "OAuth1 actual HTTP2 TLS query/form/header signatures use exact bytes and retain certificate verification",
  { timeout: 30000 },
  async (t) => {
    const key = await readFile(
        new URL("./fixtures/localhost.key", import.meta.url),
      ),
      cert = await readFile(
        new URL("./fixtures/localhost.crt", import.meta.url),
      ),
      server = http2.createSecureServer({ key, cert }),
      sessions = new Set(),
      seen = [],
      errors = [];
    const specs = new Map([
      [
        "/query",
        {
          method: "POST",
          bodyType: "json",
          body: '{"text":"雪"}',
          auth: auth(),
        },
      ],
      [
        "/form",
        {
          method: "PUT",
          bodyType: "urlencoded",
          form: [
            { key: "x", value: "one" },
            { key: "x", value: "two" },
            { key: "empty", value: "" },
          ],
          auth: auth(),
        },
      ],
      [
        "/header",
        {
          method: "POST",
          bodyType: "binary",
          body: Buffer.from([0, 255, 128, 7]).toString("base64"),
          auth: auth("header"),
        },
      ],
      ["/empty", { method: "GET", bodyType: "none", auth: auth() }],
    ]);
    server.on("session", (s) => sessions.add(s));
    server.on("stream", async (stream, headers) => {
      try {
        const chunks = [];
        for await (const c of stream) chunks.push(c);
        const bytes = Buffer.concat(chunks),
          url = "https://" + headers[":authority"] + headers[":path"],
          path = new URL(url).pathname,
          spec = specs.get(path);
        seen.push(path);
        assert(spec);
        const clean = { ...headers, host: headers[":authority"] };
        const checked = verifyOAuth1Policy({
          url,
          method: headers[":method"],
          headers: clean,
          body: bytes,
          auth: spec.auth,
          bodyType: spec.bodyType,
        });
        assert.deepEqual(checked.ordinaryQuery, [
          ["dup", "1"],
          ["dup", "2"],
        ]);
        if (spec.bodyType === "urlencoded")
          assert.deepEqual(
            checked.ordinaryForm,
            spec.form.map((f) => [f.key, f.value]),
          );
        else
          assert.deepEqual(
            bytes,
            spec.bodyType === "binary"
              ? Buffer.from(spec.body, "base64")
              : Buffer.from(spec.body || ""),
          );
        if (bytes.length)
          assert.equal(Number(headers["content-length"]), bytes.length);
        stream.respond({ ":status": 200, "content-type": "application/json" });
        stream.end('{"verified":true}');
      } catch (error) {
        errors.push(error.message);
        if (!stream.destroyed) {
          stream.respond({ ":status": 401 });
          stream.end("independent verification failed");
        }
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      for (const s of sessions) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    });
    const base = "https://127.0.0.1:" + server.address().port;
    await assert.rejects(
      executeRequest({
        ...specs.get("/query"),
        url: base + "/query?dup=1&dup=2",
        httpVersion: "2",
      }),
      /certificate|self.signed/i,
    );
    assert.equal(seen.length, 0);
    for (const [path, spec] of specs) {
      const result = await executeRequest({
        ...spec,
        url: base + path + "?dup=1&dup=2",
        httpVersion: "2",
        tls: { ca: cert.toString() },
      });
      assert.equal(result.status, 200, JSON.stringify({ result, errors }));
    }
    assert.equal(seen.length, 4);
    assert.deepEqual(errors, []);
  },
);
test(
  "OAuth1 actual HTTP proxy signs the target query/form and does not follow default redirects",
  { timeout: 30000 },
  async (t) => {
    const seen = [],
      errors = [];
    let forbidden = 0;
    const target = http.createServer((req, res) => {
      forbidden++;
      req.resume();
      res.end("must not receive credentials");
    });
    await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
    const proxy = http.createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const bytes = Buffer.concat(chunks),
          url = new URL(req.url),
          isForm = url.pathname === "/form",
          bodyType = isForm
            ? "urlencoded"
            : url.pathname === "/redirect"
              ? "none"
              : "json";
        seen.push(url.pathname);
        assert.equal(url.host, "unresolvable.invalid");
        assert.equal(req.headers.host, "unresolvable.invalid");
        assert.equal(
          req.headers["proxy-authorization"],
          "Basic " + Buffer.from("proxy-user:proxy-pass").toString("base64"),
        );
        const checked = verifyOAuth1Policy({
          url: url.href,
          method: req.method,
          headers: req.headers,
          body: bytes,
          auth: auth(),
          bodyType,
        });
        assert.deepEqual(checked.ordinaryQuery, [
          ["dup", "1"],
          ["dup", "2"],
        ]);
        if (isForm)
          assert.deepEqual(checked.ordinaryForm, [
            ["x", "a+b"],
            ["x", "雪"],
          ]);
        else
          assert.deepEqual(
            bytes,
            Buffer.from(bodyType === "none" ? "" : '{"proxy":true}'),
          );
        if (bytes.length)
          assert.equal(Number(req.headers["content-length"]), bytes.length);
        if (url.pathname === "/redirect") {
          res.writeHead(302, {
            location:
              "http://127.0.0.1:" + target.address().port + "/must-not-follow",
          });
          res.end();
        } else res.end("verified");
      } catch (error) {
        errors.push(error.message);
        res.statusCode = 401;
        res.end("independent verification failed");
      }
    });
    await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      proxy.closeAllConnections();
      target.closeAllConnections();
      await Promise.all([
        new Promise((resolve) => proxy.close(resolve)),
        new Promise((resolve) => target.close(resolve)),
      ]);
    });
    const via =
      "http://proxy-user:proxy-pass@127.0.0.1:" + proxy.address().port;
    for (const [path, method, bodyType, body, form, status] of [
      ["/json", "POST", "json", '{"proxy":true}', [], 200],
      [
        "/form",
        "POST",
        "urlencoded",
        "",
        [
          { key: "x", value: "a+b" },
          { key: "x", value: "雪" },
        ],
        200,
      ],
      ["/redirect", "GET", "none", "", [], 302],
    ]) {
      const result = await executeRequest({
        url: "http://unresolvable.invalid" + path + "?dup=1&dup=2",
        method,
        bodyType,
        body,
        form,
        auth: auth(),
        proxy: via,
      });
      assert.equal(result.status, status, JSON.stringify({ result, errors }));
    }
    assert.deepEqual(seen, ["/json", "/form", "/redirect"]);
    assert.equal(forbidden, 0);
    assert.deepEqual(errors, []);
  },
);
