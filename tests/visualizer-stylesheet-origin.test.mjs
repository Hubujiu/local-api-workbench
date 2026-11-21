import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";

test("opaque visualizer may load only the exact static stylesheet, without expanding API or document authority", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "visualizer-origin-"));
  const app = await createApp({ root, port: 0 });
  try {
    const css = await fetch(app.url + "/visualizer.css", {
      headers: { origin: "null" },
    });
    assert.equal(css.status, 200);
    assert.equal(css.headers.get("content-type"), "text/css");
    assert.equal(css.headers.get("x-content-type-options"), "nosniff");
    assert.equal(css.headers.get("access-control-allow-origin"), null);
    assert.equal(
      await css.text(),
      await readFile(
        new URL("../public/visualizer.css", import.meta.url),
        "utf8",
      ),
    );
    for (const [url, method, origin] of [
      ["/api/session", "GET", "null"],
      ["/api/projects", "GET", "null"],
      ["/app.js", "GET", "null"],
      ["/", "GET", "null"],
      ["/style.css", "GET", "null"],
      ["/visualizer.css?extra=1", "GET", "null"],
      ["/visualizer.css", "POST", "null"],
      ["/visualizer.css", "OPTIONS", "null"],
      ["/visualizer.css", "GET", "https://untrusted.example"],
    ]) {
      const response = await fetch(app.url + url, {
        method,
        headers: { origin, "x-local-token": app.token },
      });
      assert.equal(response.status, 403, `${method} ${url} ${origin}`);
      assert.equal((await response.json()).error, "Origin rejected");
    }
    const badHost = await new Promise((resolve, reject) => {
      http
        .get(
          app.url + "/visualizer.css",
          { headers: { origin: "null", host: "untrusted.example" } },
          (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => (body += chunk));
            response.on("end", () =>
              resolve({ status: response.statusCode, body }),
            );
          },
        )
        .on("error", reject);
    });
    assert.equal(badHost.status, 403);
    assert.equal(JSON.parse(badHost.body).error, "Host rejected");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
