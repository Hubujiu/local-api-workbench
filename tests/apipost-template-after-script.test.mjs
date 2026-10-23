import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runPlan, normalizeRequest } from "../src/core.mjs";
import { executeRequest } from "../src/runtime.mjs";
import { validateApipostTemplateRequest } from "../public/apipost-function-template.js";
const request = (url) =>
  normalizeRequest({
    method: "POST",
    url,
    bodyType: "raw",
    body: "{{@value:apipost_body}}",
    bodyDynamic: {
      apipost_body: {
        source: "apipost-body-function",
        value: "{{token|upper}}",
        format: "text",
        functions: [],
      },
    },
  });
async function fixture(t) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    seen.push(body);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ body }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return { url: "http://127.0.0.1:" + server.address().port, seen };
}

test("template after-scripts observe sent output and propagate variables only to following requests", async (t) => {
  const { url, seen } = await fixture(t);
  const first = request(url);
  first.afterScript =
    'pm.test("resolved body",()=>pm.expect(pm.response.json().body).to.equal("BEFORE"));apt.setVar("token","after");';
  const result = await runPlan(
    { functions: [], steps: [{ request: first }, { request: request(url) }] },
    { token: "before" },
    executeRequest,
  );
  assert.equal(result.status, "passed", JSON.stringify(result));
  assert.deepEqual(seen, ["BEFORE", "AFTER"]);
  assert(
    result.results[0].assertions.some(
      (a) => a.name === "resolved body" && a.passed,
    ),
  );
});

test("template shared after-scripts preserve ordered state and failed assertion evidence", async (t) => {
  const { url, seen } = await fixture(t);
  const first = request(url);
  first.sharedAfterScripts = [
    { name: "project", code: 'apt.setVar("token","project");' },
    {
      name: "folder",
      code: 'apt.setVar("token",apt.getVar("token")+"-folder");',
    },
  ];
  first.afterScript =
    'pm.test("ordered",()=>pm.expect(apt.getVar("token")).to.equal("project-folder"));pm.test("stop",()=>pm.expect(1).to.equal(2));';
  const result = await runPlan(
    { functions: [], steps: [{ request: first }] },
    { token: "before" },
    executeRequest,
  );
  assert.equal(result.status, "failed", JSON.stringify(result));
  assert.deepEqual(seen, ["BEFORE"]);
  assert.equal(result.results[0].response.status, 200);
  assert.equal(JSON.parse(result.results[0].response.body).body, "BEFORE");
  assert(
    result.results[0].assertions.some((a) => a.name === "stop" && !a.passed),
  );
});

test("after-script support does not enable pre-scripts or declarative operation combinations", () => {
  for (const extra of [
    { beforeScript: "apt.setVar('x',1)" },
    { sharedBeforeScripts: [{ name: "project", code: "1" }] },
    { before: [{ type: "wait", ms: 1 }] },
    { after: [{ type: "wait", ms: 1 }] },
    { scriptURLMode: "sdk" },
  ])
    assert.throws(() =>
      validateApipostTemplateRequest({
        ...request("http://fixture"),
        ...extra,
      }),
    );
});
