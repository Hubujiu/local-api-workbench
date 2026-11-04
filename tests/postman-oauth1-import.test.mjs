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
