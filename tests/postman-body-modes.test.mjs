import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { importDocument } from "../src/core.mjs";
import { executeRequest } from "../src/runtime.mjs";

const collection = (body, url = "http://127.0.0.1:9/static") => ({
  info: { name: "Body mode fixture" },
  item: [{ name: "Static", request: { method: "POST", url, body } }],
});
const imported = (body) => importDocument(collection(body))[0];

test("Postman disabled body ignores all legal inactive payloads, but rejects ambiguous flags and modes", () => {
  for (const mode of [
    undefined,
    "raw",
    "urlencoded",
    "formdata",
    "file",
    "graphql",
  ]) {
    const body = {
      mode,
      disabled: true,
      raw: { invalid: true },
      urlencoded: 42,
      formdata: false,
      graphql: null,
    };
    Object.defineProperty(body, "file", {
      get() {
        throw Error("must not inspect local file payload");
      },
    });
    const request = imported(body);
    assert.equal(request.bodyType, "none");
    assert.equal(request.body, "");
    assert.deepEqual(request.form, []);
  }
  for (const disabled of [undefined, null, "false", "true", 0, 1, {}, []])
    assert.throws(
      () => imported({ mode: "raw", raw: "static", disabled }),
      /disabled/,
    );
  for (const mode of ["binary", "none", "", null, 42]) {
    assert.throws(() => imported({ mode }), /正文模式/);
    assert.throws(() => imported({ mode, disabled: true }), /正文模式/);
  }
  assert.equal(imported({}).bodyType, "none");
  assert.equal(imported(undefined).bodyType, "none");
});

test("Postman active file body fails safely without reading either src or inline content", () => {
  for (const file of [
    { src: "/must-not-read/private.txt" },
    { content: "not-proven-binary" },
  ])
    assert.throws(
      () => imported({ mode: "file", file }),
      /不自动导入Postman二进制文件正文/,
    );
  const body = { mode: "file" };
  Object.defineProperty(body, "file", {
    get() {
      throw Error("payload touched");
    },
  });
  assert.throws(() => imported(body), /不自动导入Postman二进制文件正文/);
});

test("Postman active mode selects its own form rows and preserves file selection guards", () => {
  const request = imported({
    mode: "formdata",
    urlencoded: [],
    formdata: [
      { key: "text", value: "kept", type: "text" },
      { key: "upload", type: "file", src: "/not-read/picture.png" },
      { key: "off", value: "not-sent", disabled: true },
    ],
  });
  assert.equal(request.bodyType, "form-data");
  assert.deepEqual(
    request.form.map((row) => row.key),
    ["text", "upload", "off"],
  );
  assert.equal(request.form[1].requiresFile, true);
  assert.equal(request.form[1].filename, "picture.png");
  assert.equal(request.form[1].value, "");
  assert.equal(request.form[2].enabled, false);
  const encoded = imported({
    mode: "urlencoded",
    urlencoded: [{ key: "active", value: "yes" }],
    formdata: [{ key: "stale", value: "no" }],
  });
  assert.equal(encoded.form[0].key, "active");
  const raw = imported({
    mode: "raw",
    raw: '{"ok":true}',
    options: { raw: { language: "json" } },
    formdata: [{ key: "stale" }],
  });
  assert.equal(raw.bodyType, "json");
  assert.equal(raw.body, '{"ok":true}');
  assert.deepEqual(raw.form, []);
});

test("Postman raw, urlencoded and multipart preserve actual HTTP bodies; disabled sends no body and unselected file never sends", async (t) => {
  const seen = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    seen.push({
      body: Buffer.concat(chunks).toString(),
      type: request.headers["content-type"],
    });
    response.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}/static`;
  const bodies = [
    { mode: "raw", raw: "raw 中文" },
    {
      mode: "urlencoded",
      urlencoded: [
        { key: "message", value: "a & 中文" },
        { key: "off", value: "bad", disabled: true },
      ],
    },
    {
      mode: "formdata",
      urlencoded: [],
      formdata: [
        { key: "message", value: "multipart 中文", type: "text" },
        { key: "off", value: "bad", disabled: true },
      ],
    },
  ];
  for (const body of bodies) {
    const request = importDocument(collection(body, url))[0];
    assert.equal(request.beforeScript, "");
    assert.equal(request.afterScript, "");
    const result = await executeRequest(request);
    assert.equal(result.status, 200);
  }
  assert.equal(seen[0].body, "raw 中文");
  assert.deepEqual(
    [...new URLSearchParams(seen[1].body)],
    [["message", "a & 中文"]],
  );
  assert.match(seen[2].body, /name="message"\r\n\r\nmultipart 中文/);
  assert.doesNotMatch(seen[2].body, /name="off"/);
  for (const body of [
    ...bodies,
    { mode: "file", file: { src: "/not-read" } },
    { mode: "graphql", graphql: null },
  ]) {
    const request = importDocument(
      collection({ ...body, disabled: true }, url),
    )[0];
    assert.equal((await executeRequest(request)).status, 200);
    assert.equal(seen.at(-1).body, "");
  }
  const count = seen.length;
  const file = importDocument(
    collection(
      {
        mode: "formdata",
        urlencoded: [],
        formdata: [
          { key: "upload", type: "file", src: "/not-read/picture.png" },
        ],
      },
      url,
    ),
  )[0];
  await assert.rejects(executeRequest(file), /重新选择导入的文件/);
  assert.equal(seen.length, count);
});
