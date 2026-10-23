// Execute only generated commands for fixed loopback fixtures. Linux CI lane.
import assert from "node:assert/strict";
import http from "node:http";
import http2 from "node:http2";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { toCurl, interpolate } from "../src/core.mjs";
import { resolveDynamicRequest } from "../src/dynamic-values.mjs";
import { executeRequest } from "../src/runtime.mjs";
const exec = promisify(execFile);
const sessions = new Set();
const reply = (req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ url: req.url, body, method: req.method }));
  });
};
const servers = [http.createServer(reply), http2.createServer(reply)];
servers[1].on("session", (session) => {
  sessions.add(session);
  session.on("close", () => sessions.delete(session));
});
try {
  for (const [index, server] of servers.entries()) {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const source = {
      url: `http://127.0.0.1:${server.address().port}/{id}?raw=%2f+&flag&x=1&x=2`,
      scriptURLMode: "sdk",
      httpVersion: index ? "2" : "1.1",
      method: "POST",
      bodyType: "raw",
      body: "O'Brien + literal",
      path: [{ key: "id", value: "42" }],
      queryAddEqual: false,
      query: [
        { key: "table", value: "a+b&c" },
        { key: "empty", value: "" },
        { key: "off", value: "absent", enabled: false },
      ],
    };
    const resolved = await resolveDynamicRequest(source, {}, [], interpolate);
    const direct = JSON.parse((await executeRequest(resolved)).body);
    const { stdout } = await exec("/bin/sh", ["-c", toCurl(source)], {
      timeout: 5000,
      maxBuffer: 65536,
    });
    assert.deepEqual(JSON.parse(stdout), direct);
    assert.equal(direct.url, "/42?raw=%2f+&flag&x=1&x=2&table=a%2Bb%26c&empty");
    assert.equal(direct.body, source.body);
  }
  console.log("SDK_URL_CURL_HTTP1_HTTP2_WIRE_EQUIVALENCE_PASSED");
} finally {
  for (const session of sessions) session.destroy();
  for (const server of servers) {
    server.closeAllConnections?.();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}
