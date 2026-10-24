import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { snapshotPlan, runPlan } from "../src/core.mjs";
import { executeRequest } from "../src/runtime.mjs";

test("actual plan pipeline resolves URL query providers once and retains post-phase SDK metadata", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    req.resume();
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const request = {
      url: `http://127.0.0.1:${server.address().port}/:id?raw=%2f+&x=first&x=second`,
      scriptURLMode: "sdk",
      scriptDialect: "apipost8",
      query: [
        {
          key: "dynamic",
          value: "",
          dynamic: { source: "variable", value: "value" },
        },
        {
          key: "deleted",
          value: "",
          dynamic: { source: "variable", value: "undefined-never-read" },
        },
        {
          key: "off",
          value: "{{unknown}}",
          enabled: false,
          description: "retained",
        },
      ],
      beforeScript: `
   pm.variables.set('value','{{literal}}+&');
   pm.request.url.variables.upsert({key:'id',value:'42'});
   pm.request.url.query.remove('deleted');
   pm.request.url.query.one('x').value='changed';
   pm.request.url.query.members.reverse();
  `,
      afterScript: `
   pm.test('object URL',()=>pm.expect(typeof pm.request.url).to.equal('object'));
   pm.test('disabled metadata',()=>{pm.expect(pm.request.url.query.one('off').disabled).to.equal(true);pm.expect(pm.request.url.query.one('off').description.content).to.equal('retained');});
   pm.test('resolved variable',()=>pm.expect(pm.request.url.query.one('dynamic').value).to.equal('{{literal}}+&'));
  `,
    };
    const plan = snapshotPlan({ steps: [{ request }] });
    const original = structuredClone(plan);
    const result = await runPlan(plan, {}, executeRequest);
    assert.equal(result.status, "passed", JSON.stringify(result.results));
    assert.deepEqual(plan, original);
    assert.equal(seen.length, 1);
    assert.equal(
      seen[0],
      "/42?dynamic=%7B%7Bliteral%7D%7D%2B%26&x=changed&x=first&raw=%2f+",
    );
    assert(result.results[0].assertions.every((x) => x.passed));
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("URL query providers share the existing aggregate dynamic limits with other fields", async () => {
  for (const request of [
    {
      query: Array.from({ length: 100 }, (_, i) => ({
        key: "q" + i,
        value: "",
        dynamic: { source: "fixed", value: "x" },
      })),
      headers: [
        { key: "h", value: "", dynamic: { source: "fixed", value: "x" } },
      ],
    },
    {
      query: [
        {
          key: "q",
          value: "",
          dynamic: {
            source: "fixed",
            value: "x",
            functions: Array(10).fill("f"),
          },
        },
      ],
      headers: [
        {
          key: "h1",
          value: "",
          dynamic: {
            source: "fixed",
            value: "x",
            functions: Array(6).fill("f"),
          },
        },
        {
          key: "h2",
          value: "",
          dynamic: {
            source: "fixed",
            value: "x",
            functions: Array(6).fill("f"),
          },
        },
      ],
    },
  ]) {
    let sends = 0;
    const result = await runPlan(
      snapshotPlan({
        steps: [
          {
            request: {
              url: "http://example.test",
              scriptURLMode: "sdk",
              ...request,
            },
          },
        ],
      }),
      {},
      async () => {
        sends++;
        return { status: 200, headers: {}, body: "{}" };
      },
    );
    assert.equal(sends, 0);
    assert.equal(result.status, "failed");
    assert.match(result.results[0].error, /最多100个动态值|最多20次动态函数/);
  }
});

test("active Path rows use whole-segment conversion and SDK variable mutation with a shared provider budget", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    req.resume();
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const request = {
      url: `http://127.0.0.1:${server.address().port}/{id}/:second.txt`,
      scriptURLMode: "sdk",
      scriptDialect: "apipost8",
      path: [
        { key: "id", value: "{{base}}", description: "table path" },
        {
          key: "second",
          value: "",
          dynamic: { source: "variable", value: "number" },
        },
        {
          key: "removed",
          value: "",
          dynamic: { source: "variable", value: "never-defined" },
        },
      ],
      beforeScript:
        "pm.variables.set('base','A B');pm.variables.set('number',42);pm.request.url.variables.remove('removed');pm.request.url.variables.members.reverse();",
      afterScript:
        "pm.test('resolved path',()=>{pm.expect(pm.request.url.getPath()).to.equal('/A B/42.txt');pm.expect(pm.request.url.variables.get('second')).to.equal('42');});",
    };
    const result = await runPlan(
      snapshotPlan({ steps: [{ request }] }),
      {},
      executeRequest,
    );
    assert.equal(result.status, "passed", JSON.stringify(result.results));
    assert.deepEqual(seen, ["/A%20B/42.txt"]);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("disabled Path rows retain metadata without entering SDK lookup or evaluating providers", async () => {
  const disabled = {
    key: "id",
    value: "{{unused}}",
    enabled: false,
    description: "preserved",
    dynamic: { source: "variable", value: "undefined-never-read" },
  };
  const plan = snapshotPlan({
    steps: [
      {
        request: {
          url: "http://example.test/{id}",
          scriptURLMode: "sdk",
          path: [disabled],
          afterScript:
            "pm.test('disabled not in SDK variables',()=>pm.expect(pm.request.url.variables.has('id')).to.equal(false));",
        },
      },
    ],
  });
  let sent;
  const result = await runPlan(plan, {}, async (request) => {
    sent = request;
    return { status: 200, headers: {}, body: "{}" };
  });
  assert.equal(result.status, "passed", JSON.stringify(result.results));
  assert.equal(sent.url, "http://example.test/:id");
  assert.deepEqual(sent.scriptURLRuntime.inactivePath, [disabled]);
  assert.deepEqual(plan.steps[0].request.path, [disabled]);
});

test("SDK URL edits reach actual HTTP/2 without duplicate query encoding", async () => {
  const http2 = await import("node:http2");
  const server = http2.createServer();
  const sessions = new Set(),
    seen = [];
  server.on("session", (session) => {
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
  });
  server.on("stream", (stream, headers) => {
    seen.push(headers[":path"]);
    stream.respond({ ":status": 200, "content-type": "application/json" });
    stream.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const plan = snapshotPlan({
      steps: [
        {
          request: {
            url: `http://127.0.0.1:${server.address().port}/?raw=%2f+`,
            httpVersion: "2",
            scriptURLMode: "sdk",
            query: [{ key: "table", value: "+&" }],
            beforeScript:
              "pm.request.url.query.add({key:'flag',value:null});pm.request.url.query.add({key:'raw-added',value:'a+b'});",
          },
        },
      ],
    });
    const result = await runPlan(plan, {}, executeRequest);
    assert.equal(result.status, "passed", JSON.stringify(result.results));
    assert.deepEqual(seen, ["/?raw=%2f+&table=%2B%26&flag&raw-added=a+b"]);
  } finally {
    for (const session of sessions) session.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("unsupported SDK phase data fails before transport and cannot mutate the saved source", async () => {
  const plan = snapshotPlan({
    steps: [
      {
        request: {
          url: "http://example.test/:id",
          scriptURLMode: "sdk",
          beforeScript:
            "pm.request.url.variables.upsert({key:'id',value:()=>42});",
        },
      },
    ],
  });
  const before = structuredClone(plan);
  let sends = 0;
  const result = await runPlan(plan, {}, async () => {
    sends++;
  });
  assert.equal(result.status, "failed");
  assert.equal(sends, 0);
  assert.equal(result.results[0].scriptStage, "serialization");
  assert.deepEqual(plan, before);
});
