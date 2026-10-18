import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { oauth1Authorization, oauthEncode } from "../src/oauth1.mjs";
import { executeRequest } from "../src/runtime.mjs";
const auth = {
  consumerKey: "dpf43f3p2l4k3l03",
  consumerSecret: "kd94hf93k423kf44",
  accessToken: "nnch734d00sl2jdk",
  tokenSecret: "pfkkdhi9sl3r4s00",
  timestamp: "137131202",
  nonce: "chapoH",
};
test("OAuth1 matches RFC5849 section1.2 protected-photo signature", () => {
  const signed = oauth1Authorization(
    "http://photos.example.net/photos?file=vacation.jpg&size=original",
    "GET",
    {},
    undefined,
    auth,
  );
  assert.equal(signed.signature, "MdpQcU8iPSUjWoN/UDMsK2sui9I=");
  assert.equal(oauthEncode(" !'()*"), "%20%21%27%28%29%2A");
  assert(!signed.header.includes(auth.consumerSecret));
});
test("OAuth1 preserves duplicate form/query fields, encoded ordering, empty values and actual Host", () => {
  const signed = oauth1Authorization(
    "http://example.com/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b",
    "POST",
    { "content-type": "application/x-www-form-urlencoded" },
    "c2&a3=2+q",
    {
      consumerKey: "9djdj82h48djs9d2",
      consumerSecret: "j49sk3j29djd",
      accessToken: "kkk9d7dh3k39sjv7",
      tokenSecret: "dh893hdasih9",
      timestamp: "137131201",
      nonce: "7d8f3e4a",
    },
  );
  assert.equal(
    signed.normalized,
    "a2=r%20b&a3=2%20q&a3=a&b5=%3D%253D&c%40=&c2=&oauth_consumer_key=9djdj82h48djs9d2&oauth_nonce=7d8f3e4a&oauth_signature_method=HMAC-SHA1&oauth_timestamp=137131201&oauth_token=kkk9d7dh3k39sjv7",
  );
  assert(
    oauth1Authorization(
      "http://127.0.0.1/test",
      "GET",
      { host: "EXAMPLE.COM:80" },
      null,
      auth,
    ).baseString.includes("http%3A%2F%2Fexample.com%2Ftest"),
  );
  assert.throws(
    () =>
      oauth1Authorization(
        "http://example.test/?oauth_nonce=x",
        "GET",
        {},
        null,
        auth,
      ),
    /协议字段/,
  );
  assert.throws(
    () =>
      oauth1Authorization("http://example.test", "GET", {}, null, {
        ...auth,
        signatureMethod: "PLAINTEXT",
      }),
    /仅支持/,
  );
});
test("real HTTP OAuth1 signs the final query and urlencoded body", async (t) => {
  let captured;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    captured = {
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString(),
    };
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const result = await executeRequest({
    url: base + "/signed",
    method: "POST",
    query: [{ key: "q", value: "a b" }],
    bodyType: "urlencoded",
    form: [
      { key: "x", value: "1" },
      { key: "x", value: "2" },
    ],
    auth: { type: "oauth1", ...auth },
  });
  assert.equal(result.status, 200);
  const expected = oauth1Authorization(
    base + captured.url,
    "POST",
    captured.headers,
    captured.body,
    auth,
  );
  assert.equal(captured.headers.authorization, expected.header);
  assert.equal(captured.body, "x=1&x=2");
});
test("OAuth1 import retains credentials and unsupported cURL export fails explicitly", async () => {
  const { importDocument, toCurl } = await import("../src/core.mjs");
  const imported = importDocument({
    info: { name: "OAuth1 fixture" },
    item: [
      {
        name: "signed",
        request: {
          method: "GET",
          url: "https://example.test",
          auth: {
            type: "oauth1",
            oauth1: Object.entries(auth).map(([key, value]) => ({
              key,
              value,
            })),
          },
        },
      },
    ],
  });
  assert.equal(imported[0].auth.consumerKey, auth.consumerKey);
  assert.equal(imported[0].auth.tokenSecret, auth.tokenSecret);
  assert.throws(() => toCurl(imported[0]), /OAuth1/);
});
