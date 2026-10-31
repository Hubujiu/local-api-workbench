import test from "node:test";
import assert from "node:assert/strict";
import { applyNativeOAuth2 } from "../src/native-oauth2-token.mjs";
const native = (definition) => ({ type: "oauth2", nativeOAuth2: definition });
test("native OAuth2 query vectors preserve literal plus, escapes, duplicate keys and unrelated URL spelling", () => {
  for (const [value, encoded] of [
    ["a+b", "a+b"],
    ["a%2fb", "a%2fb"],
    ["a b", "a%20b"],
    ["a&b#c=d", "a%26b%23c=d"],
    ["雪", "%E9%9B%AA"],
    ["%ZZ", "%25ZZ"],
    ["'(*)", "%27%28%2A%29"],
  ]) {
    const url = new URL(
        "https://example.invalid/%2f?access_token=old&dup=1&dup=2&flag&empty=#kept",
      ),
      before = url.href,
      headers = { authorization: "Caller credential" },
      auth = native({
        addTokenTo: "queryParams",
        access_token: value,
        headerPrefix: "{{unused}}",
      }),
      saved = structuredClone(auth);
    assert.equal(applyNativeOAuth2(url, headers, auth), true);
    assert.equal(
      url.href,
      before.replace("#kept", "&access_token=" + encoded + "#kept"),
    );
    assert.deepEqual(headers, { authorization: "Caller credential" });
    assert.deepEqual(auth, saved);
  }
});
test("native OAuth2 header defaults, explicit prefix and empty/no-placement behavior are isolated", () => {
  for (const prefix of [undefined, "", "Custom"]) {
    const definition = { addTokenTo: "header", access_token: "token" };
    if (prefix !== undefined) definition.headerPrefix = prefix;
    const url = new URL("https://example.invalid/?access_token=old"),
      headers = { authorization: "old" };
    applyNativeOAuth2(url, headers, native(definition));
    assert.equal(headers.authorization, (prefix || "Bearer") + " token");
    assert.equal(url.search, "?access_token=old");
  }
  for (const definition of [
    {},
    { addTokenTo: "", access_token: "{{unused}}" },
    { access_token: "{{unused}}" },
    { addTokenTo: "header", access_token: "", headerPrefix: "{{unused}}" },
  ]) {
    const url = new URL("https://example.invalid/?a=%2f"),
      headers = { authorization: "Caller" };
    applyNativeOAuth2(url, headers, native(definition));
    assert.equal(url.href, "https://example.invalid/?a=%2f");
    assert.deepEqual(headers, { authorization: "Caller" });
  }
  assert.equal(
    applyNativeOAuth2(
      new URL("https://example.invalid"),
      {},
      { type: "oauth2", token: "legacy" },
    ),
    false,
  );
});
test("native OAuth2 unsafe active inputs reject without partial URL/header mutation or echoed secrets", () => {
  for (const addTokenTo of ["header", "queryParams"])
    for (const access_token of [
      "secret\r\nInjected: yes",
      "x\0secret",
      "{{secret}}",
      "x".repeat(8193),
    ]) {
      const url = new URL("https://example.invalid/?a=%2f"),
        headers = { authorization: "Caller" };
      assert.throws(
        () =>
          applyNativeOAuth2(url, headers, native({ addTokenTo, access_token })),
        (error) => error.message === "原生 OAuth2 令牌注入字段无效",
      );
      assert.equal(url.href, "https://example.invalid/?a=%2f");
      assert.deepEqual(headers, { authorization: "Caller" });
    }
  const headers = { authorization: "Caller" };
  assert.throws(() =>
    applyNativeOAuth2(
      new URL("https://example.invalid"),
      headers,
      native({
        addTokenTo: "header",
        access_token: "token",
        headerPrefix: "secret\n",
      }),
    ),
  );
  assert.equal(headers.authorization, "Caller");
});
