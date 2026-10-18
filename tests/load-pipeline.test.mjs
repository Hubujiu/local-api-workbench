import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";

test("load runs the actual script and dynamic pipeline with isolated variable scopes and truthful summaries", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "load-pipeline-"));
  const app = await createApp({ root, port: 0 }),
    received = [];
  let slowSeen;
  const slowStarted = new Promise((resolve) => {
    slowSeen = resolve;
  });
  const fixture = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString(),
    });
    if (req.url === "/slow") {
      slowSeen();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end('{"token":"load-token","ok":true}');
  });
  await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    fixture.closeAllConnections();
    await new Promise((resolve) => fixture.close(resolve));
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const url = "http://127.0.0.1:" + fixture.address().port,
    project = await app.store.create("load pipeline");
  const invoke = async (request, concurrency = 1) => {
    const response = await fetch(
      app.url + "/api/projects/" + project.id + "/load",
      {
        method: "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          request,
          count: 2,
          concurrency,
          runId: "pipeline-load",
        }),
      },
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  const failed = await invoke({
    url: url + "/main",
    afterScript: 'pm.test("must fail",()=>pm.expect(1).to.equal(2));',
  });
  assert.equal(
    failed.passed,
    0,
    "post-script assertions must not be ignored by load",
  );
  assert.equal(failed.results[0].assertionFailures[0].name, "must fail");
  received.length = 0;
  const passed = await invoke(
    {
      url: url + "/main",
      method: "POST",
      bodyType: "json",
      body: '{"n":{{@value:n}}}',
      bodyDynamic: {
        n: { source: "fixed", value: 2, functions: [], format: "json" },
      },
      headers: [
        { key: "authorization", value: "Bearer {{loadToken}}" },
        { key: "x-load-seq", value: "{{seq}}" },
      ],
      beforeScript: `pm.environment.set('seq',(pm.environment.get('seq')||0)+1);pm.sendRequest(${JSON.stringify(url + "/token")},(error,response)=>{if(error)throw error;pm.environment.set('loadToken',response.json().token);});`,
      afterScript: 'pm.environment.set("loadOnly",true);',
    },
    2,
  );
  assert.equal(passed.passed, 2, JSON.stringify(passed));
  assert.equal(passed.concurrency, 2);
  assert.equal(passed.scriptRequests, 2);
  assert.equal(passed.mainRequests, 2);
  assert.equal(passed.variableIsolation, "per-request");
  assert.equal(received.length, 4);
  for (const request of received.filter((item) => item.url === "/main")) {
    assert.equal(request.headers.authorization, "Bearer load-token");
    assert.equal(JSON.parse(request.body).n, 2);
    assert.equal(request.headers["x-load-seq"], "1");
  }
  const cancelledRun = invoke({ url: url + "/slow" });
  await slowStarted;
  const cancellation = await fetch(app.url + "/api/cancel", {
    method: "POST",
    headers: { "x-local-token": app.token, "content-type": "application/json" },
    body: JSON.stringify({ id: "pipeline-load" }),
  });
  assert.equal(cancellation.status, 200);
  const cancelled = await cancelledRun;
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.count, 1);
  assert.equal(cancelled.passed, 0);
  const saved = await app.store.get(project.id);
  assert.equal(saved.environments[0].variables.loadOnly, undefined);
  assert.equal(saved.environments[0].variables.loadToken, undefined);
});
