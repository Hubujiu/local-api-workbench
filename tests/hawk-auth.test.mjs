import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import Hawk from "hawk";
import { hawkAuthorization } from "../src/hawk-auth.mjs";
import { executeRequest } from "../src/runtime.mjs";
const auth = {
  id: "dh37fgj492je",
  key: "werxhqb98rpaxn39848xrunpaw3489ruxnpa98w4rxn",
  algorithm: "sha256",
  timestamp: "1353832234",
  nonce: "j4h3g2",
  ext: "some-app-ext-data",
};
const url = "http://example.com:8000/resource/1?b=1&a=2";
test("Hawk matches Mozilla documented request and payload MAC vectors", () => {
  const plain = hawkAuthorization(url, "GET", {}, undefined, auth);
  assert.equal(
    /mac="([^"]+)"/.exec(plain.header)[1],
    "6R4rV5iE+NPoym+WwjeHzjAGXUtLNIxmo1vpMofpLAE=",
  );
  const payload = hawkAuthorization(
    url,
    "POST",
    { "content-type": "text/plain" },
    "Thank you for flying Hawk",
    auth,
  );
  assert.equal(
    payload.artifacts.hash,
    "Yi9LfIIFRtBEPt74PVmbTF/xVAwPn7ub15ePICfgnuY=",
  );
  assert.equal(
    /mac="([^"]+)"/.exec(payload.header)[1],
    "aSe1DERmZuRl3pI36/9BdZmnErTw3sNzOOAUlfeKjVw=",
  );
  assert(!plain.header.includes(auth.key));
});
test("Hawk rejects invalid configuration and supports explicit payload-hash opt out", () => {
  assert.throws(
    () => hawkAuthorization(url, "GET", {}, undefined, {}),
    /id与key/,
  );
  assert.throws(
    () =>
      hawkAuthorization(url, "GET", {}, undefined, {
        ...auth,
        algorithm: "md5",
      }),
    /sha1/,
  );
  assert.throws(
    () =>
      hawkAuthorization(url, "GET", {}, undefined, {
        ...auth,
        timestamp: "bad",
      }),
    /时间戳/,
  );
  assert.equal(
    hawkAuthorization(url, "POST", {}, "body", {
      ...auth,
      payloadHash: "disabled",
    }).artifacts.hash,
    undefined,
  );
});
test("real outgoing Hawk request passes server MAC and payload validation", async (t) => {
  const credentials = {
    id: "local-fixture",
    key: "local-fixture-key",
    algorithm: "sha256",
  };
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      await Hawk.server.authenticate(
        req,
        async (id) => {
          assert.equal(id, credentials.id);
          return credentials;
        },
        { payload: Buffer.concat(chunks) },
      );
      res.end("authenticated");
    } catch (error) {
      res.statusCode = 401;
      res.end(error.message);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await executeRequest({
    url: "http://127.0.0.1:" + server.address().port + "/signed",
    method: "POST",
    bodyType: "json",
    body: '{"n":1}',
    auth: { type: "hawk", ...credentials },
  });
  assert.equal(result.status, 200, result.body);
  assert.equal(result.body, "authenticated");
});
test("Hawk Postman import translates official field names and preserves payload-hash choice", async () => {
  const { importDocument, toCurl } = await import("../src/core.mjs");
  const [request] = importDocument({
    info: { name: "hawk" },
    item: [
      {
        name: "hawk",
        request: {
          method: "GET",
          url,
          auth: {
            type: "hawk",
            hawk: Object.entries({
              authId: auth.id,
              authKey: auth.key,
              extraData: auth.ext,
              includePayloadHash: true,
            }).map(([key, value]) => ({ key, value })),
          },
        },
      },
    ],
  });
  assert.equal(request.auth.id, auth.id);
  assert.equal(request.auth.key, auth.key);
  assert.equal(request.auth.payloadHash, "enabled");
  assert.throws(() => toCurl(request), /Hawk/);
});
