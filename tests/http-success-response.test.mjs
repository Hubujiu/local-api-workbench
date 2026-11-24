import assert from "node:assert/strict";
import test from "node:test";
import {
  isPopulatedHTTPResponse,
  prettyResponseJSON,
} from "../public/http-success-response.js";

test("only populated plain text 2xx responses enter the viewer", () => {
  const result = { status: 201, body: '{"id":101}' };
  assert(isPopulatedHTTPResponse(result));
  for (const variant of [
    null,
    { ...result, status: 404 },
    { ...result, status: "201" },
    { ...result, body: "" },
    { ...result, body: { id: 101 } },
    { ...result, error: "failed" },
    { ...result, rawBodyBase64: "" },
    { ...result, codecError: "failed" },
  ])
    assert(!isPopulatedHTTPResponse(variant));
});

test("pretty keeps numeric lexemes, duplicate names, signed zero and exact string escapes", () => {
  const source = String.raw`{"n":9007199254740993,"zero":-0,"n":1E+900,"array":[{},[],"\u0041\r\n<markup>"],"unary":null}`;
  assert.equal(
    prettyResponseJSON(source),
    [
      "{",
      '    "n": 9007199254740993,',
      '    "zero": -0,',
      '    "n": 1E+900,',
      '    "array": [',
      "        {},",
      "        [],",
      String.raw`        "\u0041\r\n<markup>"`,
      "    ],",
      '    "unary": null',
      "}",
    ].join("\n"),
  );
  assert.equal(prettyResponseJSON(" \t\r\n-0 \r"), "-0");
});

test("invalid, over-budget and deeply nested JSON stays exclusive to Raw", () => {
  for (const value of [
    "{ not json }",
    " ",
    '{"unicode":"' + "中".repeat(100000) + '"}',
    "[".repeat(65) + "0" + "]".repeat(65),
    "[" + new Array(25000).fill(0).join(",") + "]",
  ])
    assert.equal(prettyResponseJSON(value), null);
});
