import test from "node:test";
import assert from "node:assert/strict";
import {
  captureResponseHeaderEvidence,
  readResponseCookieEvidence,
  readResponseHeaderEvidence,
} from "../src/response-header-evidence.mjs";
import { nativeCookieName } from "../src/native-cookie-name.mjs";

const receipt = (lines, protocol = "1.1") => {
  const response = {};
  captureResponseHeaderEvidence(
    response,
    ["x-proof", "yes", ...lines.flatMap((line) => ["set-cookie", line])],
    protocol,
  );
  return response;
};

test("shared Cookie evidence preserves exact existing bounded ordinary-name semantics", () => {
  for (const protocol of ["1.0", "1.1", "2.0"]) {
    const response = receipt(
      [
        "Session=A=B==; Path=/",
        "session=%E4%B8%AD",
        "bad=%ZZ",
        "space=%20x%20",
      ],
      protocol,
    );
    const cookie = readResponseCookieEvidence(response);
    assert.equal(cookie.complete, true);
    assert.deepEqual(
      { ...cookie.values },
      {
        Session: "A=B==",
        session: "中",
        bad: "%ZZ",
        space: " x ",
      },
    );
    assert.ok(Object.isFrozen(cookie));
    assert.ok(Object.isFrozen(cookie.values));
    assert.equal(readResponseHeaderEvidence(response).counts["set-cookie"], 4);
    assert.equal(readResponseCookieEvidence({ ...response }).complete, false);
  }
  assert.equal(readResponseCookieEvidence(receipt([])).complete, true);
});

test("unsupported or ambiguous cookies reject globally without downgrading Header evidence", () => {
  for (const lines of [
    ["good=one", "good=two"],
    ["good=one", "a.b=two"],
    ["good=one", "a[b]=two"],
    ["good=one", "constructor=two"],
    ["good=one", "bad="],
    ["good=one", "bad"],
    ["good=one", " bad=two"],
    ["good=one", "bad= two"],
    ["good=one", "bad=two ; Path=/"],
    ["good=one", "bad=\ud800"],
    ["good=one", `bad=${"x".repeat(65536)}`],
  ]) {
    const response = receipt(lines);
    assert.equal(readResponseCookieEvidence(response).complete, false);
    assert.equal(readResponseHeaderEvidence(response).complete, true);
  }
  for (const name of ["__proto__", "prototype", "toString", "x.y", " x "])
    assert.equal(nativeCookieName(name), false);
  assert.equal(nativeCookieName("A_b-~9"), true);
});

test("shared evidence accepts only complete bounded dense own raw transport pairs", () => {
  let calls = 0;
  const accessor = ["set-cookie", "x=y"];
  Object.defineProperty(accessor, 1, {
    get() {
      calls++;
      return "x=y";
    },
  });
  const sparse = new Array(2);
  sparse.extra = "set-cookie";
  sparse.other = "x=y";
  for (const raw of [
    accessor,
    sparse,
    ["set-cookie"],
    Array(257).fill(["x", "y"]).flat(),
  ]) {
    const response = {};
    captureResponseHeaderEvidence(response, raw, "1.1");
    assert.equal(readResponseHeaderEvidence(response).complete, false);
    assert.equal(readResponseCookieEvidence(response).complete, false);
  }
  assert.equal(calls, 0);
  const response = {};
  captureResponseHeaderEvidence(response, ["set-cookie", "x=y"], "3");
  assert.equal(readResponseCookieEvidence(response).complete, false);
  captureResponseHeaderEvidence(
    response,
    Array(256).fill(["x", "y"]).flat(),
    "1.1",
  );
  assert.equal(readResponseHeaderEvidence(response).complete, true);
  assert.equal(readResponseCookieEvidence(response).complete, true);
});
