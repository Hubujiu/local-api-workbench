import test from "node:test";
import assert from "node:assert/strict";
import { resolveApipostFunctionTemplate } from "../src/apipost-function-templates.mjs";
import { parseApipostFunctionTemplate } from "../public/apipost-function-template.js";

test("source Base64 text stages match independent Unicode and URL-safe vectors", async () => {
  for (const token of ["", "abc", "中文 😀", "\u0000a"]) {
    const encoded = Buffer.from(token, "utf8").toString("base64");
    assert.equal(
      await resolveApipostFunctionTemplate("{{token|base64}}", [], "body", {
        token,
      }),
      encoded,
    );
    assert.equal(
      await resolveApipostFunctionTemplate("{{token|unbase64}}", [], "body", {
        token: encoded,
      }),
      token,
    );
  }
  for (const token of ["8J-YgA", "77-_", " YQ==\r\n", "YQ"])
    assert.equal(
      await resolveApipostFunctionTemplate("{{token|unbase64}}", [], "body", {
        token,
      }),
      Buffer.from(token, "base64").toString("utf8"),
    );
  assert.equal(
    await resolveApipostFunctionTemplate(
      "{{'abc'|base64|unbase64|upper}}",
      [],
      "body",
    ),
    "ABC",
  );
});

test("Base64 stages reject unsupported byte inputs and preserve bounds without custom-code access", async () => {
  for (const token of ["%%%", "YR==", "/w==", "A", "YQ==="])
    await assert.rejects(
      resolveApipostFunctionTemplate("{{token|unbase64}}", [], "body", {
        token,
      }),
    );
  await assert.rejects(
    resolveApipostFunctionTemplate("{{token|base64}}", [], "body", {
      token: "\ud800",
    }),
  );
  await assert.rejects(
    resolveApipostFunctionTemplate("{{token|base64}}", [], "body", {
      token: null,
    }),
  );
  await assert.rejects(
    resolveApipostFunctionTemplate("{{token|base64|length}}", [], "body", {
      token: "x".repeat(50000),
    }),
    /64KiB/,
  );
  assert.throws(
    () => parseApipostFunctionTemplate("{{$function.fn_seed(x)|base64}}"),
    /共享函数/,
  );
  assert.throws(() => parseApipostFunctionTemplate("{{'x'|base64(secret)}}"));
});
