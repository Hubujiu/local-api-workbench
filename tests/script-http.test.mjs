import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runScript } from "../src/scripts.mjs";
import { runPlan, snapshotPlan } from "../src/core.mjs";
import { executeRequest } from "../src/runtime.mjs";
async function fixture(t) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    requests.push({
      url: req.url,
      body: Buffer.concat(parts).toString(),
      headers: req.headers,
    });
    if (req.url === "/slow") return;
    if (req.url === "/large") {
      res.end("x".repeat(262145));
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ token: "callback-token", ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return { url: "http://127.0.0.1:" + server.address().port, requests };
}
test("bounded callback HTTP scripts complete before variable persistence and retain subrequest evidence", async (t) => {
  const f = await fixture(t);
  const plan = snapshotPlan({
    steps: [
      {
        request: {
          url: f.url + "/main",
          headers: [{ key: "authorization", value: "Bearer {{token}}" }],
          beforeScript: `pm.sendRequest({url:${JSON.stringify(f.url + "/token")},method:'POST',header:{'content-type':'application/json'},body:{mode:'raw',raw:'{"source":"script"}'}},(error,response)=>{if(error)throw error;pm.test('token status',()=>pm.expect(response.code).to.equal(200));pm.environment.set('token',response.json().token);console.log('callback complete');});`,
        },
      },
    ],
  });
  const run = await runPlan(plan, {}, executeRequest);
  assert.equal(run.status, "passed", JSON.stringify(run.results));
  assert.deepEqual(
    f.requests.map((r) => r.url),
    ["/token", "/main"],
  );
  assert.equal(f.requests[0].body, '{"source":"script"}');
  assert.equal(f.requests[1].headers.authorization, "Bearer callback-token");
  assert.equal(run.results[0].subrequests[0].response.status, 200);
  assert.equal(run.results[0].subrequests[0].phase, "before");
  assert.equal(run.results[0].assertions[0].passed, true);
});
test("network permission is absent in pure function scripts and unsupported APIs fail without sending", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runScript(`pm.sendRequest(${JSON.stringify(f.url)},()=>{});`, {
      variables: {},
    }),
    /网络|HTTP/,
  );
  await assert.rejects(
    runScript(
      `input.allowNetwork=true;pm.sendRequest(${JSON.stringify(f.url)},()=>{});`,
      { variables: {} },
    ),
    /网络|HTTP/,
  );
  await assert.rejects(
    runScript(`pm.sendRequest(${JSON.stringify(f.url)},123);`, {
      variables: {},
      allowNetwork: true,
    }),
    /回调/,
  );
  assert.equal(f.requests.length, 0);
  const result = await runScript(
    "pm.sendRequest('file:///etc/passwd',(error)=>{apt.setVar('blocked',!!error);});",
    { variables: {}, allowNetwork: true },
  );
  assert.equal(result.variables.blocked, true);
  assert.equal(f.requests.length, 0);
});
test("script HTTP callback failures do not become successful plans", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runScript(
      `pm.sendRequest(${JSON.stringify(f.url)},()=>{throw Error('callback rejected');});`,
      { variables: {}, allowNetwork: true },
    ),
    (error) => {
      assert.match(error.message, /callback rejected/);
      assert.equal(error.networkRequests[0].response.status, 200);
      return true;
    },
  );
  const failedPlan = await runPlan(
    snapshotPlan({
      steps: [
        {
          request: {
            url: f.url + "/main",
            beforeScript: `pm.sendRequest(${JSON.stringify(f.url)},()=>{throw Error('record callback failure');});`,
          },
        },
      ],
    }),
    {},
    executeRequest,
  );
  assert.equal(failedPlan.status, "failed");
  assert.equal(failedPlan.results[0].subrequests[0].response.status, 200);
  assert.equal(failedPlan.results[0].subrequests[0].phase, "before");
  const result = await runScript(
    `pm.sendRequest(${JSON.stringify(f.url)},(error,response)=>{pm.test('expected error',()=>pm.expect(response.code).to.equal(201));});`,
    { variables: {}, allowNetwork: true },
  );
  assert.equal(result.tests[0].passed, false);
});
test("script HTTP cancellation aborts in-flight work", async (t) => {
  const f = await fixture(t),
    controller = new AbortController();
  const pending = runScript(
    `pm.sendRequest(${JSON.stringify(f.url + "/slow")},()=>{});`,
    { variables: {}, allowNetwork: true },
    { signal: controller.signal },
  );
  pending.catch(() => {});
  const until = Date.now() + 1500;
  while (!f.requests.length && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await assert.rejects(pending, /取消|abort/i);
  assert.equal(f.requests.length, 1);
});

test("script HTTP request count, response size and callback compute remain bounded", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runScript(
      `function go(n){pm.sendRequest(${JSON.stringify(f.url)},()=>{if(n<11)go(n+1);});}go(1);`,
      { variables: {}, allowNetwork: true },
    ),
    /最多10/,
  );
  assert.equal(f.requests.length, 10);
  const large = await runScript(
    `pm.sendRequest(${JSON.stringify(f.url + "/large")},error=>apt.setVar('error',error.message));`,
    { variables: {}, allowNetwork: true },
  );
  assert.match(large.variables.error, /256KiB/);
  await assert.rejects(
    runScript(`pm.sendRequest(${JSON.stringify(f.url)},()=>{while(true){}});`, {
      variables: {},
      allowNetwork: true,
    }),
    /interrupt|超时/i,
  );
  await assert.rejects(
    runScript(
      `for(let i=0;i<5;i++)pm.sendRequest(${JSON.stringify(f.url + "/slow")},()=>{});`,
      { variables: {}, allowNetwork: true },
    ),
    /同时4/,
  );
});

test("callback assertions await brokered HTTP without losing registration order", async (t) => {
  const f = await fixture(t);
  const result = await runScript(
    `
    pm.test('network', done => {
      pm.sendRequest(${JSON.stringify(f.url)}, (err,res) => {
        if(err) return done(err);
        try { pm.expect(res.code).to.equal(200); pm.variables.set('completed',true); done(); }
        catch(error) { done(error); }
      });
    });
    pm.test('sync', () => {});
  `,
    { variables: {}, allowNetwork: true },
  );
  assert.deepEqual(
    result.tests.map((x) => [x.name, x.passed]),
    [
      ["network", true],
      ["sync", true],
    ],
  );
  assert.equal(result.localVariables.completed, true);
  assert.equal(result.networkRequests.length, 1);
});

test("Promise HTTP and async callback scripts preserve actual subrequest evidence", async (t) => {
  const f = await fixture(t);
  const result = await runScript(
    `const response=await pm.sendRequest(${JSON.stringify(f.url + "/token")});apt.setVar('status',response.code);pm.sendRequest(${JSON.stringify(f.url + "/main")},async(error,response)=>{if(error)throw error;await new Promise(resolve=>setTimeout(resolve,5));apt.setVar('callbackStatus',response.code)});`,
    { variables: {}, allowNetwork: true },
  );
  assert.equal(result.variables.status, 200);
  assert.equal(result.variables.callbackStatus, 200);
  assert.equal(result.networkRequests.length, 2);
  await assert.rejects(
    runScript(
      `pm.sendRequest(${JSON.stringify(f.url)},async()=>{await 1;throw Error('async HTTP rejected')});`,
      { variables: {}, allowNetwork: true },
    ),
    /async HTTP rejected/,
  );
  await assert.rejects(
    runScript("await pm.sendRequest('file:///etc/passwd')", {
      variables: {},
      allowNetwork: true,
    }),
    /HTTP|URL|协议|file/i,
  );
});
