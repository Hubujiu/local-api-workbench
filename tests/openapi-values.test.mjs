import test from "node:test";
import assert from "node:assert/strict";
import { importDocument } from "../src/core.mjs";
const doc = (value) => ({
  openapi: "3.1.0",
  paths: {
    "/value": {
      post: {
        parameters: [
          {
            in: "cookie",
            name: "session",
            required: true,
            example: "fixture",
            schema: { type: "string" },
          },
        ],
        requestBody: { content: { "application/json": { example: value } } },
        responses: {
          200: {
            description: "OK",
            content: { "application/json": { example: value } },
          },
        },
      },
    },
  },
});
test("OpenAPI preserves falsy JSON request and response examples", () => {
  for (const value of [false, 0, "", null]) {
    const [r] = importDocument(doc(value));
    assert.equal(r.body, JSON.stringify(value));
    assert.equal(r.examples[0].body, JSON.stringify(value));
  }
});
test("OpenAPI imports cookie parameters as cookies, not lost metadata", () => {
  const [r] = importDocument(doc({}));
  assert.equal(r.cookies.length, 1);
  assert.deepEqual(r.cookies[0], {
    key: "session",
    value: "fixture",
    required: true,
    description: "",
    schema: { type: "string" },
    enabled: true,
  });
});
test("OpenAPI named examples select inline values without fetching external content", () => {
  const d = doc({});
  delete d.paths["/value"].post.requestBody.content["application/json"].example;
  d.paths["/value"].post.requestBody.content["application/json"].examples = {
    remote: { externalValue: "https://example.invalid/value.json" },
    inline: { value: false },
  };
  assert.equal(importDocument(d)[0].body, "false");
});

test("imported false JSON and cookie parameters reach a real HTTP service", async (t) => {
  const { createServer } = await import("node:http");
  const { executeRequest } = await import("../src/runtime.mjs");
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        body,
        cookie: req.headers.cookie,
        contentType: req.headers["content-type"],
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const source = doc(false);
  source.servers = [{ url: `http://127.0.0.1:${server.address().port}` }];
  const result = await executeRequest(importDocument(source)[0]);
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), {
    body: "false",
    cookie: "session=fixture",
    contentType: "application/json",
  });
});
