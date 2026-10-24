import test from "node:test";
import assert from "node:assert/strict";
import { edgegridAuthorization } from "../src/edgegrid-auth.mjs";
const auth = {
  clientToken: "akab-client-token-xxx-xxxxxxxxxxxxxxxx",
  accessToken: "akab-access-token-xxx-xxxxxxxxxxxxxxxx",
  clientSecret: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=",
  timestamp: "20140321T19:34:21+0000",
  nonce: "nonce-xx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
};
const url =
  "https://akaa-baseurl-xxxxxxxxxxx-xxxxxxxxxxxxx.luna.akamaiapis.net/testapi/v1/t3?extended=true";
test("EdgeGrid matches Akamai official Python JSON request golden signature", () => {
  const result = edgegridAuthorization(
    url,
    "POST",
    { "content-type": "application/json" },
    '{"key": "value"}',
    auth,
  );
  assert.equal(
    result,
    "EG1-HMAC-SHA256 client_token=akab-client-token-xxx-xxxxxxxxxxxxxxxx;access_token=akab-access-token-xxx-xxxxxxxxxxxxxxxx;timestamp=20140321T19:34:21+0000;nonce=nonce-xx-xxxx-xxxx-xxxx-xxxxxxxxxxxx;signature=nONuDe50qGrPius4Rg4D2jfi/2zDZWAYRUG6RudJLNM=",
  );
  assert(!result.includes(auth.clientSecret));
});
test("EdgeGrid hashes bounded bytes only for POST and preserves ordered normalized signed headers", () => {
  const limited = { ...auth, maxBodySize: 2, headersToSign: "X-Test" };
  assert.equal(
    edgegridAuthorization(
      url,
      "POST",
      { "x-test": " a   b " },
      "é-rest",
      limited,
    ),
    edgegridAuthorization(
      url,
      "POST",
      { "X-Test": "a b" },
      Buffer.from("é"),
      limited,
    ),
  );
  assert.equal(
    edgegridAuthorization(url, "PUT", {}, "one", auth),
    edgegridAuthorization(url, "PUT", {}, "two", auth),
  );
  assert.notEqual(
    edgegridAuthorization(url, "POST", {}, "one", auth),
    edgegridAuthorization(url, "POST", {}, "two", auth),
  );
  assert.throws(
    () =>
      edgegridAuthorization(url, "GET", {}, null, {
        ...auth,
        nonce: "bad;header",
      }),
    /非法字符/,
  );
  assert.throws(
    () =>
      edgegridAuthorization(url, "GET", {}, null, { ...auth, maxBodySize: -1 }),
    /Hash/,
  );
});
test("real HTTP EdgeGrid wire signature and Postman import preserve explicit parameters", async (t) => {
  const http = await import("node:http");
  const { executeRequest } = await import("../src/runtime.mjs");
  const { importDocument, toCurl } = await import("../src/core.mjs");
  let wire;
  const server = http.createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    wire = { headers: req.headers, body: Buffer.concat(parts) };
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const local = "http://127.0.0.1:" + server.address().port + "/signed?q=1";
  const result = await executeRequest({
    url: local,
    method: "POST",
    bodyType: "json",
    body: '{"key":"value"}',
    auth: { type: "edgegrid", ...auth },
  });
  assert.equal(result.status, 200);
  assert.equal(
    wire.headers.authorization,
    edgegridAuthorization(local, "POST", wire.headers, wire.body, auth),
  );
  const [request] = importDocument({
    info: { name: "EdgeGrid" },
    item: [
      {
        name: "edgegrid",
        request: {
          method: "GET",
          url,
          auth: {
            type: "edgegrid",
            edgegrid: Object.entries(auth).map(([key, value]) => ({
              key,
              value,
            })),
          },
        },
      },
    ],
  });
  assert.equal(request.auth.clientToken, auth.clientToken);
  assert.throws(() => toCurl(request), /EdgeGrid/);
});
