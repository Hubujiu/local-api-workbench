import test from "node:test";
import assert from "node:assert/strict";
import { selectMockResponse } from "../src/mock.mjs";
test("Mock examples preserve explicit empty bodies, literal headers and delay instead of inventing JSON", () => {
  const example = {
    name: "empty",
    status: 200,
    body: "",
    headers: { "content-type": "text/plain", "x-example": "yes" },
    delayMs: 15,
  };
  const selected = selectMockResponse({ examples: [example] }, {});
  assert.equal(selected.body, "");
  assert.deepEqual(selected.headers, example.headers);
  assert.equal(selected.delayMs, 15);
  assert.equal(
    selectMockResponse({ examples: [{ status: 200 }] }, {}).body,
    "{}",
  );
});
test("Mock example final responses reject informational status, malformed values and transport-header overrides", () => {
  for (const patch of [
    { status: 100 },
    { status: 200.5 },
    { status: 0 },
    { body: {} },
    { headers: [] },
    { headers: { "content-length": "8" } },
    { headers: { x: "a\r\nb" } },
    { headers: { x: "a", X: "b" } },
    { delayMs: -1 },
    { delayMs: 5001 },
  ])
    assert.throws(() =>
      selectMockResponse(
        { examples: [{ status: 200, body: "ok", ...patch }] },
        {},
      ),
    );
});

test("example edits preserve metadata and validate all changes before replacing an example", async () => {
  const { editResponseExample, validateMockResponse } = await import(
    "../public/response-example.js"
  );
  const previous = {
    id: "stable",
    name: "original",
    status: 200,
    body: "old",
    headers: { "content-type": "application/xml" },
    schema: { type: "string" },
    extension: { keep: true },
  };
  const before = structuredClone(previous);
  const edited = editResponseExample(previous, {
    name: "new",
    status: 200,
    body: "",
    headers: previous.headers,
    delayMs: 0,
  });
  assert.equal(edited.id, "stable");
  assert.deepEqual(edited.schema, previous.schema);
  assert.deepEqual(edited.extension, previous.extension);
  assert.equal(edited.body, "");
  assert.deepEqual(previous, before);
  for (const patch of [
    { status: NaN },
    { status: 200.5 },
    { headers: { Connection: "close" } },
    { headers: { x: "中" } },
    { body: "\ud800" },
    { headers: { x: "x".repeat(8193) } },
    {
      headers: Object.fromEntries(
        Array.from({ length: 9 }, (_, i) => ["x-" + i, "x".repeat(8192)]),
      ),
    },
    { body: "x".repeat(8 * 1024 * 1024 + 1) },
  ])
    assert.throws(() =>
      editResponseExample(previous, {
        name: "new",
        status: 200,
        body: "",
        headers: {},
        delayMs: 0,
        ...patch,
      }),
    );
  assert.deepEqual(previous, before);
  const informational = editResponseExample(previous, {
    name: "continue",
    status: 100,
    body: "",
    headers: {},
    delayMs: 0,
  });
  assert.throws(() => validateMockResponse(informational));
});
test("shared literal header validation agrees with the HTTP engine for allowed values", async () => {
  const { validateMockResponse } = await import(
    "../public/response-example.js"
  );
  const { validateHeaderName, validateHeaderValue } = await import("node:http");
  for (const [name, value] of [
    ["x-fixture", ""],
    ["X-Fixture", "value\ttext"],
    ["content-type", "text/plain; charset=utf-8"],
    ["x-latin", "é"],
  ]) {
    validateHeaderName(name);
    validateHeaderValue(name, value);
    validateMockResponse({ status: 200, body: "", headers: { [name]: value } });
  }
});
test("Mock sends exact example bodies and headers over HTTP and suppresses bodies for 204/205/304", async (t) => {
  const { createApp } = await import("../src/server.mjs");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const http = await import("node:http");
  const root = await mkdtemp(join(tmpdir(), "mock-examples-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    await new Promise((r) => app.server.close(r));
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  const project = await app.store.create("Exact response examples");
  project.requests = [
    {
      id: "example",
      name: "example",
      url: "http://localhost",
      examples: [
        {
          status: 200,
          body: "",
          headers: { "content-type": "text/plain", "x-example": "retained" },
          delayMs: 1,
        },
        ...[204, 205, 304].map((status) => ({
          status,
          body: "must not be sent",
        })),
        { status: 100, body: "" },
        {
          status: 200,
          body: "<root>中</root>",
          headers: { "content-type": "application/xml" },
        },
      ],
    },
  ];
  await app.store.save(project);
  const request = (index, method = "GET") =>
    new Promise((resolve, reject) => {
      const req = http.request(
        app.url + "/mock/" + project.id + "/example?example=" + index,
        { method },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks).toString(),
            }),
          );
          res.on("error", reject);
        },
      );
      req.setTimeout(3000, () => req.destroy(Error("fixture timeout")));
      req.on("error", reject);
      req.end();
    });
  for (const index of ["", "-1", "1.5", "bad", "6", "0&example=5"]) {
    const invalid = await request(index);
    assert.equal(invalid.status, 400, index);
    assert.match(invalid.body, /示例/);
  }
  const empty = await request(0);
  assert.equal(empty.status, 200);
  assert.equal(empty.body, "");
  assert.equal(empty.headers["content-type"], "text/plain");
  assert.equal(empty.headers["x-example"], "retained");
  for (let i = 1; i <= 3; i++) {
    const response = await request(i);
    assert.equal(response.status, [204, 205, 304][i - 1]);
    assert.equal(response.body, "");
  }
  assert.equal((await request(4)).status, 400);
  const xml = await request(5);
  assert.equal(xml.body, "<root>中</root>");
  assert.equal(xml.headers["content-type"], "application/xml");
  assert.equal((await request(5, "HEAD")).body, "");
});

test("explicit Mock example selection never silently returns a different or invented response", () => {
  const request = {
    examples: [
      { status: 200, body: "first" },
      { status: 201, body: "second" },
    ],
  };
  assert.equal(
    selectMockResponse(request, { query: { example: "1" } }).body,
    "second",
  );
  for (const example of [
    "",
    "-1",
    "1.5",
    "01",
    "1e0",
    "0x1",
    "bad",
    "2",
    "9007199254740992",
    [],
    false,
  ])
    assert.throws(
      () => selectMockResponse(request, { query: { example } }),
      /示例/,
    );
  assert.throws(
    () =>
      selectMockResponse({ examples: [] }, { query: { example: "0" } }, () => ({
        status: 200,
        body: "schema",
      })),
    /示例/,
  );
  assert.throws(() => selectMockResponse({ examples: [null] }, {}), /示例/);
  assert.equal(
    selectMockResponse({ examples: [] }, {}, () => ({
      status: 200,
      body: "schema",
    })).body,
    "schema",
  );
});

test("explicit example selection bypasses conditional rules but ordinary Mock retains rule priority", () => {
  const request = {
    examples: [{ status: 201, body: "selected" }],
    mockRules: [{ conditions: [], response: { status: 202, body: "rule" } }],
  };
  assert.equal(selectMockResponse(request, {}).body, "rule");
  assert.equal(
    selectMockResponse(request, { query: { example: "0" } }).body,
    "selected",
  );
});
test("Mock debug targets preserve unrelated query values and do not mutate source rows", async () => {
  const { mockURL, mockDebugTarget } = await import("../public/mock-target.js");
  const request = {
    id: "r",
    examples: [{ status: 200 }],
    query: [
      { key: "example", value: "old", enabled: true, description: "retain" },
      { key: "scenario", value: "smart", enabled: true },
    ],
  };
  const original = structuredClone(request);
  const target = mockDebugTarget("http://localhost:1234", "p", request, 0);
  assert.equal(target.url, "http://localhost:1234/mock/p/r?example=0");
  assert.deepEqual(target.query, [
    { ...request.query[0], enabled: false },
    request.query[1],
  ]);
  assert.deepEqual(request, original);
  assert.throws(
    () => mockDebugTarget("http://localhost", "p", request, 1),
    /示例/,
  );
  assert.throws(() => mockURL("file:///", "p", "r"), /HTTP/);
  assert(!mockURL("http://localhost", "p", '"<r>').includes('"'));
});
