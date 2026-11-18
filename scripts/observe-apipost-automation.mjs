import http from "node:http";
import path from "node:path";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";

// Only record the fixture's labels. Do not log other URLs, headers or bodies.
const output = process.argv[2];
if (!output)
  throw Error("Usage: node scripts/observe-apipost-automation.mjs OUTPUT");
mkdirSync(output, { recursive: true });
const write = (name, value) =>
  writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + "\n");
const steps = ["first", "second", "off"];
const routes = new Set([...steps, "first-new", "copied"].map((s) => "/" + s));
const server = http.createServer((request, response) => {
  const allowed = request.method === "GET" && routes.has(request.url);
  if (allowed) {
    const entry = {
      at: new Date().toISOString(),
      method: "GET",
      path: request.url,
    };
    appendFileSync(
      path.join(output, "original-http.jsonl"),
      JSON.stringify(entry) + "\n",
    );
  }
  response.writeHead(allowed ? 200 : 404, {
    "content-type": "application/json",
  });
  response.end(JSON.stringify({ ok: allowed }));
});
server.listen(0, "127.0.0.1", () => {
  const origin = "http://127.0.0.1:" + server.address().port;
  write("listen.json", { origin, pid: process.pid });
  write("loopback-postman.json", {
    info: {
      name: "Workbench 827 Loopback QA",
      schema:
        "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: steps.map((name) => ({
      name: "QA " + name,
      request: { method: "GET", url: origin + "/" + name },
    })),
  });
  console.log(origin);
});
