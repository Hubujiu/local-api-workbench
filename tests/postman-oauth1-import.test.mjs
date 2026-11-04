import test from "node:test";
import assert from "node:assert/strict";
import { importPostmanOAuth1 } from "../src/postman-oauth1-import.mjs";
const attrs = (extra = {}) =>
  Object.entries({
    consumerKey: "fictional-key",
    consumerSecret: "fictional-secret",
    token: "fictional-token",
    signatureMethod: "HMAC-SHA1",
    ...extra,
  }).map(([key, value]) => ({ key, value, type: typeof value }));
test("official Postman token becomes canonical accessToken", () => {
  assert.equal(importPostmanOAuth1(attrs()).accessToken, "fictional-token");
});
test("omitted Postman switches retain official auto placement, not legacy header default", () => {
  assert.deepEqual(importPostmanOAuth1(attrs()).parameterPolicy, {
    placement: "auto",
    includeBodyHash: false,
    includeEmptyParams: false,
    headerEncoding: "percent",
  });
});
test("all four explicit switches survive import", () => {
  assert.deepEqual(
    importPostmanOAuth1(
      attrs({
        addParamsToHeader: true,
        includeBodyHash: true,
        addEmptyParamsToSign: true,
        disableHeaderEncoding: true,
      }),
    ).parameterPolicy,
    {
      placement: "header",
      includeBodyHash: true,
      includeEmptyParams: true,
      headerEncoding: "raw",
    },
  );
});
for (const [label, change] of [
  [
    "text false",
    (a) =>
      a.push({ key: "addParamsToHeader", value: "false", type: "boolean" }),
  ],
  [
    "string cast boolean",
    (a) => a.push({ key: "addParamsToHeader", value: false, type: "string" }),
  ],
  [
    "dynamic switch",
    (a) => a.push({ key: "includeBodyHash", value: "{{flag}}" }),
  ],
  ["duplicate", (a) => a.push(a[0])],
  [
    "ambiguous alias",
    (a) => a.push({ key: "accessToken", value: "fictional-token" }),
  ],
  [
    "unknown field",
    (a) => a.push({ key: "unrecognized-secret", value: "DO-NOT-LEAK" }),
  ],
  [
    "disabled attribute",
    (a) => {
      a[0].disabled = true;
    },
  ],
  ["missing algorithm", (a) => a.pop()],
  [
    "missing secret",
    (a) => {
      a[1].value = "";
    },
  ],
  [
    "whitespace token",
    (a) => {
      a[2].value = " \t";
    },
  ],
  [
    "template credentials",
    (a) => {
      a[1].value = "{{secret}}";
    },
  ],
  [
    "undefined type",
    (a) => {
      a[0].type = undefined;
    },
  ],
  [
    "sparse array",
    (a) => {
      delete a[0];
    },
  ],
  [
    "oversize",
    (a) => {
      a[1].value = "s".repeat(65537);
    },
  ],
])
  test(`reject ${label} without secret disclosure`, () => {
    const a = attrs();
    change(a);
    assert.throws(
      () => importPostmanOAuth1(a),
      (error) => {
        assert.equal(
          error.message,
          "Postman OAuth1 定义不在受支持的字面值子集内",
        );
        return true;
      },
    );
  });
test("direct accessor and Proxy inputs reject without hooks", () => {
  let hooks = 0;
  const a = attrs();
  Object.defineProperty(a[0], "value", {
    enumerable: true,
    get() {
      hooks++;
      return "secret";
    },
  });
  assert.throws(() => importPostmanOAuth1(a));
  assert.throws(() =>
    importPostmanOAuth1(
      new Proxy(attrs(), {
        get() {
          hooks++;
          throw Error("hook");
        },
      }),
    ),
  );
  const b = attrs();
  b[0] = new Proxy(b[0], {
    ownKeys() {
      hooks++;
      throw Error("hook");
    },
  });
  assert.throws(() => importPostmanOAuth1(b));
  assert.equal(hooks, 0);
});
test("legacy alias is explicit compatibility, not an official token field", () => {
  const a = attrs();
  a[2].key = "accessToken";
  assert.equal(importPostmanOAuth1(a).accessToken, "fictional-token");
});
test("absent and any types are supported without coercion", () => {
  const a = attrs();
  delete a[0].type;
  a[1].type = "any";
  a.push({ key: "includeBodyHash", value: false, type: "any" });
  assert.equal(importPostmanOAuth1(a).parameterPolicy.includeBodyHash, false);
});
test("failed conversion does not mutate the source", () => {
  const a = attrs({ addParamsToHeader: "false" }),
    before = structuredClone(a);
  assert.throws(() => importPostmanOAuth1(a));
  assert.deepEqual(a, before);
});
