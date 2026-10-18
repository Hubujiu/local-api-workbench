import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { executeRequest } from "../src/runtime.mjs";
import { toCurl, importCurl } from "../src/core.mjs";

test("only enabled named cookie parameters override the explicit Cookie header", async (t) => {
  const server = http.createServer((req, res) =>
    res.end(req.headers.cookie || ""),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/`;
  for (const [cookies, expected] of [
    [[], "header=kept"],
    [[{ key: "disabled", value: "no", enabled: false }], "header=kept"],
    [[{ key: "", value: "placeholder" }], "header=kept"],
    [
      [
        { key: "active", value: "yes" },
        { key: "disabled", value: "no", enabled: false },
        { key: "", value: "placeholder" },
      ],
      "active=yes",
    ],
  ]) {
    const request = {
      url,
      headers: [{ key: "Cookie", value: "header=kept" }],
      cookies,
    };
    assert.equal((await executeRequest(request)).body, expected);
    const exported = toCurl(request);
    const imported = importCurl(exported);
    assert.equal((await executeRequest(imported)).body, expected);
    assert.equal(request.headers[0].value, "header=kept");
  }
});
