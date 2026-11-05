import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { executeRequest } from "../src/runtime.mjs";
const variants = (key) => [key.toLowerCase(), key, key.toUpperCase()];
const secret = "synthetic-loopback-only-secret-".repeat(4);
async function fixture(t) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const value = {
      headers: req.headers,
      raw: req.rawHeaders,
      body: Buffer.concat(chunks).toString(),
    };
    seen.push(value);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(value));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}
function single(result, key, expected) {
  const wire = JSON.parse(result.body);
  assert.equal(wire.headers[key], expected);
  assert.equal(
    wire.raw.filter((v, i) => i % 2 === 0 && v.toLowerCase() === key).length,
    1,
  );
  assert.deepEqual(
    Object.keys(result.request.headers).filter((v) => v.toLowerCase() === key),
    [key],
  );
}
test("API-key media header casing preserves explicit auth override before body defaults", async (t) => {
  const { url } = await fixture(t);
  for (const key of variants("Content-Type")) {
    for (const [bodyType, body, extra] of [
      ["json", '{"fixture":true}', {}],
      ["raw", "plain fixture", {}],
      [
        "raw",
        "plain fixture",
        { postmanRawBody: { version: 1, language: "text" } },
      ],
      ["urlencoded", "", { form: [{ key: "fixture", value: "yes" }] }],
    ]) {
      for (const headers of [
        [],
        [{ key: "CoNtEnT-TyPe", value: "text/original" }],
      ]) {
        const result = await executeRequest({
          url,
          method: "POST",
          bodyType,
          body,
          ...extra,
          headers,
          auth: {
            type: "apiKey",
            in: "header",
            key,
            value: "application/vnd.fixture+json",
          },
        });
        single(result, "content-type", "application/vnd.fixture+json");
      }
    }
    const result = await executeRequest({
      url,
      method: "POST",
      bodyType: "form-data",
      form: [{ key: "fixture", value: "yes" }],
      auth: { type: "apiKey", in: "header", key, value: "text/overridden" },
    });
    const wire = JSON.parse(result.body);
    assert.match(
      wire.headers["content-type"],
      /^multipart\/form-data; boundary=/,
    );
    single(result, "content-type", result.request.headers["content-type"]);
  }
});
test("API-key computed length and cookie precedence are independent of field spelling", async (t) => {
  const { url } = await fixture(t);
  for (const key of variants("Content-Length")) {
    const result = await executeRequest({
      url,
      method: "POST",
      bodyType: "raw",
      body: "界",
      timeout: 1000,
      headers: [{ key: "CONTENT-LENGTH", value: "99" }],
      auth: { type: "apiKey", key, value: "77" },
    });
    single(result, "content-length", "3");
  }
  for (const key of variants("Cookie")) {
    const result = await executeRequest({
      url,
      cookies: [{ key: "fixture", value: "explicit" }],
      auth: { type: "apiKey", key, value: "old=fixture" },
    });
    single(result, "cookie", "fixture=explicit");
    const managed = await executeRequest(
      { url, auth: { type: "apiKey", key, value: "old=fixture" } },
      undefined,
      {
        cookieSession: {
          header: async () => "managed=fixture",
          capture: async () => {},
        },
      },
    );
    single(managed, "cookie", "managed=fixture");
  }
});
test("API-key overrides same-name ordinary rows without disturbing unrelated multivalue fields", async (t) => {
  const { url } = await fixture(t);
  for (const name of ["Authorization", "X-Fixture"])
    for (const key of variants(name)) {
      const result = await executeRequest({
        url,
        headers: [
          { key: name.toLowerCase(), value: "original" },
          ...(name === "X-Fixture"
            ? [{ key: name.toUpperCase(), value: "second" }]
            : []),
          { key: "X-Repeat", value: "one" },
          { key: "x-repeat", value: "two" },
          { key: "Cookie", value: "a=one" },
          { key: "cookie", value: "b=two" },
        ],
        auth: { type: "apiKey", key, value: "synthetic-auth-value" },
      });
      single(result, name.toLowerCase(), "synthetic-auth-value");
      assert.deepEqual(result.request.headers["x-repeat"], ["one", "two"]);
      assert.deepEqual(result.request.headers.cookie, ["a=one", "b=two"]);
      assert.equal(JSON.parse(result.body).headers.cookie, "a=one; b=two");
    }
});
test("fixed-name authentication including signed JWT overrides header spelling without changing signatures", async (t) => {
  const { url } = await fixture(t);
  for (const key of variants("Authorization"))
    for (const auth of [
      { type: "bearer", token: "fixture" },
      { type: "oauth2", token: "fixture" },
      { type: "basic", username: "fixture", password: "synthetic" },
      { type: "jwt", algorithm: "HS256", secret, payload: '{"sub":"fixture"}' },
    ]) {
      const result = await executeRequest({
        url,
        method: "POST",
        bodyType: "json",
        body: "{}",
        headers: [{ key, value: "original" }],
        auth,
      });
      const value = JSON.parse(result.body).headers.authorization;
      single(result, "authorization", value);
      single(result, "content-type", "application/json");
      assert.notEqual(value, "original");
      if (auth.type === "jwt") {
        const [header, payload, signature] = value.slice(7).split(".");
        assert.equal(
          signature,
          createHmac("sha256", secret)
            .update(`${header}.${payload}`)
            .digest("base64url"),
        );
      }
    }
});
test("API-key query names stay case sensitive and duplicate singleton admission remains strict", async (t) => {
  const { url, seen } = await fixture(t);
  for (const key of variants("Content-Type")) {
    await assert.rejects(
      executeRequest({
        url,
        headers: [
          { key, value: "one" },
          { key: "content-type", value: "two" },
        ],
        auth: { type: "apiKey", key, value: "three" },
      }),
      /重复/,
    );
  }
  const signal = AbortSignal.abort();
  await assert.rejects(
    executeRequest(
      { url, auth: { type: "apiKey", key: "CONTENT-TYPE", value: "fixture" } },
      signal,
    ),
  );
  assert.equal(seen.length, 0);
  const result = await executeRequest({
    url: url + "?Key=old&key=lower",
    auth: { type: "apiKey", in: "query", key: "Key", value: "new" },
  });
  assert.match(result.request.url, /Key=new/);
  assert.match(result.request.url, /key=lower/);
});

test("ordinary API-key headers leave body defaults and explicit media intact", async (t) => {
  const { url } = await fixture(t);
  for (const key of variants("X-Fixture")) {
    for (const headers of [
      [],
      [{ key: "CONTENT-TYPE", value: "text/original" }],
    ]) {
      const result = await executeRequest({
        url,
        method: "POST",
        bodyType: "json",
        body: "{}",
        headers,
        auth: { type: "apiKey", key, value: "fixture" },
      });
      single(
        result,
        "content-type",
        headers.length ? "text/original" : "application/json",
      );
      single(result, "x-fixture", "fixture");
    }
  }
});
