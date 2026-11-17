import test from "node:test";
import assert from "node:assert/strict";
import { resolveApipostFunctionTemplate } from "../src/apipost-function-templates.mjs";
import { parseApipostFunctionTemplate } from "../public/apipost-function-template.js";

test("source date format subset keeps explicit timezones and numeric calendar tokens", async () => {
  for (const [expression, expected] of [
    [
      "{{'2024-02-29T23:30:00Z'|format(YYYY-MM-DD HH:mm:ss,+02:00)}}",
      "2024-03-01 01:30:00",
    ],
    ["{{'2024-01-01T00:30:00+02:00'|format}}", "2023-12-31 22:30:00"],
    [
      "{{'2024-01-01T00:30:00.123Z'|format(YY/M/D H:m:s.SSS Z ZZ,-05:00)}}",
      "23/12/31 19:30:0.123 -05:00 -0500",
    ],
    [
      "{{'2024-01-01T00:30:00Z'|format([UTC] YYYY-MM-DDTHH:mm:ss[Z])}}",
      "UTC 2024-01-01T00:30:00Z",
    ],
  ])
    assert.equal(
      await resolveApipostFunctionTemplate(expression, [], "body"),
      expected,
    );
});

test("date format rejects unsupported locale, implicit zones and custom-code mixtures", async () => {
  for (const suffix of [
    "format(dddd)",
    "format(YYYY-MM-DD,+05:30)",
    "format(YYYY,+15:00)",
    "format(YYYY,UTC)",
    "format(YYYY,+00:00,extra)",
    "format(" + "Y".repeat(257) + ")",
  ])
    assert.throws(() =>
      parseApipostFunctionTemplate("{{'2024-01-01T00:00:00Z'|" + suffix + "}}"),
    );
  for (const token of [
    "2024-01-01",
    "2024-01-01T00:00:00",
    "not-a-date",
    "2024-02-30T00:00:00Z",
    0,
    null,
  ])
    await assert.rejects(
      resolveApipostFunctionTemplate("{{token|format}}", [], "body", { token }),
      /ISO|时间/,
    );
  assert.throws(
    () => parseApipostFunctionTemplate("{{$function.fn_seed(x)|format}}"),
    /共享函数/,
  );
});
