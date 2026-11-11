import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { importDocument } from "../src/core.mjs";
import { executeRequest } from "../src/runtime.mjs";
import { postmanImportURL } from "../src/postman-url.mjs";
const imported = (url) =>
  importDocument({
    info: { name: "Synthetic segment fixture" },
    item: [{ name: "Lookup", request: { method: "GET", url } }],
  })[0];

test("Postman complete path names retain dot suffixes without prefix collisions on wire", async () => {
  const seen = [];
  const peer = http.createServer((req, res) => {
    seen.push(req.url);
    res.end("ok");
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  try {
    for (const structured of [false, true])
      for (const suffix of ["", ".json", ".tar.gz"]) {
        const variable = [
          { key: "user-id", value: "a/b ?%中" },
          { key: "user-id", value: "a/b ?%中" },
          { key: "user", value: "WRONG" },
        ];
        const segment = ":user-id" + suffix;
        const url = structured
          ? {
              protocol: "http",
              host: "127.0.0.1",
              port: String(peer.address().port),
              path: ["users", segment, segment],
              variable,
            }
          : {
              raw: `http://127.0.0.1:${peer.address().port}/users/${segment}/${segment}`,
              variable,
            };
        const request = imported(url);
        assert.ok(request.url.includes("{user-id}" + suffix));
        const result = await executeRequest(request);
        assert.equal(result.status, 200);
        const value = encodeURIComponent("a/b ?%中") + suffix;
        assert.equal(seen.at(-1), `/users/${value}/${value}`);
      }
  } finally {
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
  }
});

test("Postman legacy identifiers, repeated references, encoded literals and URL boundaries remain intact", () => {
  for (const name of ["id", "user_id", "123", "user-id", "-id", "id-"]) {
    assert.equal(
      postmanImportURL(
        `https://user:password@example.test/:${name}/:${name}.json?q=/:no#/:no`,
      ),
      `https://user:password@example.test/{${name}}/{${name}}.json?q=/:no#/:no`,
    );
  }
  for (const segment of ["%3Aid", "literal:id", ":", ":.json", "%3Auser-id"])
    assert.equal(
      postmanImportURL(`https://example.test/${segment}`),
      `https://example.test/${segment}`,
    );
  assert.equal(postmanImportURL("{{base}}/:user-id"), "{{base}}/{user-id}");
  assert.equal(
    postmanImportURL("https://example.test/:user-id?/:ignore#/:ignore", true),
    "https://example.test/{user-id}#/:ignore",
  );
});

test("Postman duplicates preserve identical enabled strings and reject ambiguous definitions", async () => {
  const raw = "http://example.test/:user-id/:user-id.json";
  const variable = [
    { key: "user-id", value: "same" },
    { key: "user-id", value: "same" },
  ];
  assert.equal(
    imported({ raw, variable }).url,
    "http://example.test/{user-id}/{user-id}.json",
  );
  for (const second of [
    { value: "different" },
    { value: "same", disabled: true },
    { value: "same", disabled: "true" },
    { value: 1 },
    { value: null },
  ])
    assert.throws(
      () =>
        imported({
          raw,
          variable: [variable[0], { key: "user-id", ...second }],
        }),
      /重复/,
    );
  // An unused duplicate is not involved in path binding and stays outside this fix.
  assert.doesNotThrow(() =>
    imported({
      raw,
      variable: [
        ...variable,
        { key: "unused", value: "a" },
        { key: "unused", value: "b" },
      ],
    }),
  );
});

test("Unsupported complete names fail instead of rewriting a valid prefix", () => {
  for (const name of [
    "id:action",
    "id%2Dpart",
    "id{other}",
    "用户",
    "id space",
  ]) {
    assert.throws(
      () => postmanImportURL(`https://example.test/:${name}`),
      /路径变量名称/,
    );
    assert.throws(
      () =>
        postmanImportURL({
          protocol: "https",
          host: "example.test",
          path: [":" + name],
        }),
      /路径变量名称/,
    );
  }
  // A dot is the SDK suffix boundary, not part of the variable key.
  assert.equal(
    postmanImportURL("https://example.test/:user-id.ext"),
    "https://example.test/{user-id}.ext",
  );
});
