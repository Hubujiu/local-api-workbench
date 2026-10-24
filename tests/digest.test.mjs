import test from "node:test";
import assert from "node:assert/strict";
import { digestAuthorization } from "../src/digest.mjs";
test("Digest MD5 matches the published challenge/response vector", () => {
  const header = digestAuthorization(
    'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
    { username: "Mufasa", password: "Circle Of Life" },
    "GET",
    "/dir/index.html",
    "",
    "0a4f113b",
  );
  assert.match(header, /response="6629fae49393a05397450978507c4ef1"/);
  assert.match(header, /qop=auth/);
});
test("unknown digest algorithms fail explicitly", () => {
  assert.throws(
    () =>
      digestAuthorization(
        'Digest nonce="x", algorithm=unknown',
        {},
        "GET",
        "/",
      ),
    /不支持/,
  );
});
