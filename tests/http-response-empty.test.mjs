import assert from "node:assert/strict";
import test from "node:test";
import { unsentResponseData } from "../public/http-response-empty.js";

test("only the Header and Cookie response views get the empty data surface", () => {
  const header = unsentResponseData("headers");
  assert.match(
    header,
    /data-unsent-response="headers" aria-label="尚无响应头"/,
  );
  assert.match(header, /aria-hidden="true"/);
  assert.match(header, /<p>暂无数据<\/p>/);
  assert.doesNotMatch(header, /<table/);
  for (const view of ["body", "examples", "request", "logs", "constructor"])
    assert.equal(unsentResponseData(view), "");
});

test("empty Cookie has seven real columns and an accessible scrolling region", () => {
  const cookies = unsentResponseData("cookies");
  assert.match(
    cookies,
    /role="region" aria-label="响应 Cookie 表格滚动区" tabindex="0"/,
  );
  assert.match(cookies, /<table aria-label="响应 Cookie">/);
  assert.deepEqual(
    Array.from(
      cookies.matchAll(/<th scope="col">([^<]+)/g),
      ([, label]) => label,
    ),
    ["Name", "Value", "Domain", "Path", "Expires", "HttpOnly", "Secure"],
  );
  assert.match(cookies, /<tbody><tr><td colspan="7">.*<p>暂无数据<\/p>/);
});
