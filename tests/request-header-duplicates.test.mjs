import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import http2 from "node:http2";
import { executeRequest } from "../src/runtime.mjs";
import { toCurl, importCurl } from "../src/core.mjs";
const rows = () => [
  { key: "X-Repeat", value: "first" },
  { key: "x-repeat", value: "second" },
  { key: "X-Repeat", value: "disabled", enabled: false },
];
test("HTTP/1 and HTTP/2 preserve enabled duplicate ordinary header values", async (t) => {
  for (const version of ["1.1", "2"]) {
    const server = version === "2" ? http2.createServer() : http.createServer();
    const sessions = new Set();
    server.on("session", (s) => sessions.add(s));
    server.on("request", (req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ value: req.headers["x-repeat"], raw: req.rawHeaders }),
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      for (const s of sessions) s.destroy();
      server.close();
    });
    const request = {
      url: "http://127.0.0.1:" + server.address().port,
      httpVersion: version,
      headers: rows(),
    };
    const result = await executeRequest(request);
    assert.equal(JSON.parse(result.body).value, "first, second");
    if (version === "1.1") {
      const raw = JSON.parse(result.body).raw,
        values = [];
      for (let i = 0; i < raw.length; i += 2)
        if (raw[i].toLowerCase() === "x-repeat") values.push(raw[i + 1]);
      assert.deepEqual(values, ["first", "second"]);
    }
    assert.deepEqual(result.request.headers["x-repeat"], ["first", "second"]);
    const converted = importCurl(toCurl(request));
    const again = await executeRequest(converted);
    assert.equal(JSON.parse(again.body).value, "first, second");
  }
});
test("ambiguous control headers and unverified signed duplicate headers reject before network", async () => {
  for (const name of [
    "Host",
    "Content-Length",
    "Transfer-Encoding",
    "Authorization",
    "Content-Type",
  ]) {
    const request = {
      url: "http://127.0.0.1:1",
      headers: [
        { key: name, value: "first" },
        { key: name.toLowerCase(), value: "second" },
      ],
    };
    await assert.rejects(executeRequest(request), /重复/);
    assert.throws(() => toCurl(request), /重复/);
  }
  for (const type of ["aws", "hawk", "edgegrid"])
    await assert.rejects(
      executeRequest({
        url: "http://127.0.0.1:1",
        headers: rows(),
        auth: { type },
      }),
      /重复/,
    );
});
