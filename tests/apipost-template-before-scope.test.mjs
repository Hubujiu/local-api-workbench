import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runPlan, normalizeRequest } from "../src/core.mjs";
import { executeRequest } from "../src/runtime.mjs";
const request = (url) =>
  normalizeRequest({
    method: "POST",
    url,
    query: [
      {
        key: "q",
        value: "",
        dynamic: {
          source: "apipost-function",
          value: "{{token|upper}}",
          functions: [],
        },
      },
    ],
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
    for await (const c of req) chunks.push(c);
    seen.push({ url: req.url, body: Buffer.concat(chunks).toString() });
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return { url: "http://127.0.0.1:" + server.address().port, seen };
}

test("scope-only template pre-scripts use final local and runtime variables", async (t) => {
  const { url, seen } = await fixture(t);
  const r = request(url);
  r.beforeScript =
    'apt.setVar("token","runtime");pm.variables.set("token","local");';
  const result = await runPlan(
    { functions: [], steps: [{ request: r }] },
    { token: "before" },
    executeRequest,
  );
  assert.equal(result.status, "passed", JSON.stringify(result));
  assert.deepEqual(seen, [{ url: "/?q=LOCAL", body: "LOCAL" }]);
  assert.equal(result.variables.token, "runtime");
});

test("scope-only template shared pre-scripts preserve ordered variables", async (t) => {
  const { url, seen } = await fixture(t);
  const r = request(url);
  r.sharedBeforeScripts = [
    { name: "project", code: 'apt.setVar("token","project");' },
    {
      name: "folder",
      code: 'apt.setVar("token",apt.getVar("token")+"-folder");',
    },
  ];
  r.beforeScript = 'apt.setVar("token",apt.getVar("token")+"-request");';
  const result = await runPlan(
    { functions: [], steps: [{ request: r }] },
    { token: "before" },
    executeRequest,
  );
  assert.equal(result.status, "passed", JSON.stringify(result));
  assert.deepEqual(seen, [
    { url: "/?q=PROJECT-FOLDER-REQUEST", body: "PROJECT-FOLDER-REQUEST" },
  ]);
});

test("unsupported template pre-script request mutations fail before transport", async (t) => {
  const { url, seen } = await fixture(t);
  for (const code of [
    'apt.setRequestQuery("q","override");',
    'apt.removeRequestQuery("q");',
    'apt.setRequestHeader("x-test","changed");',
    'pm.request.body.update("changed");',
  ]) {
    const r = request(url);
    r.beforeScript = code;
    const result = await runPlan(
      { functions: [], steps: [{ request: r }] },
      { token: "before" },
      executeRequest,
    );
    assert.equal(result.status, "failed", JSON.stringify(result));
    assert.equal(result.results[0].response, undefined);
    assert.match(result.results[0].error, /请求修改|正文|body/i);
  }
  assert.deepEqual(seen, []);
});
