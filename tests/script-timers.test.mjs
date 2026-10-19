import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runScript } from "../src/scripts.mjs";

test("bounded timers settle assertions, preserve callback arguments and cancel pending work", async () => {
  const result = await runScript(
    `
    const order=[];
    const cancelled=setTimeout(()=>{throw Error('cancelled timer ran')},0);
    clearTimeout(cancelled); clearTimeout(cancelled); clearTimeout(123456);
    pm.test('delayed',done=>setTimeout((a,b)=>{
      order.push(a+b); pm.variables.set('answer',a+b); done();
      setTimeout(()=>{order.push('nested');apt.setVar('order',order)},0);
    },10,2,3));
    order.push('sync');
  `,
    { variables: {} },
  );
  assert.equal(result.tests[0].passed, true);
  assert.equal(result.localVariables.answer, 5);
  assert.deepEqual(result.variables.order, ["sync", 5, "nested"]);
});

test("timer failures, invalid delays and scheduling limits are explicit", async () => {
  for (const [code, pattern] of [
    ["setTimeout(()=>{throw Error('timer failure')},0)", /timer failure/],
    ["setTimeout(async()=>{},0)", /Promise/],
    ['setTimeout("1 + 1",0)', /回调函数/],
    ["setTimeout(()=>{},1001)", /延迟/],
    ["setTimeout(()=>{},-1)", /延迟/],
    ["setTimeout(()=>{},NaN)", /延迟/],
    ["for(let i=0;i<33;i++)setTimeout(()=>{},1000)", /32/],
    ["for(let i=0;i<101;i++)clearTimeout(setTimeout(()=>{},0))", /100/],
    ["setTimeout(()=>{while(true){}},0)", /interrupt|超时|终止/i],
  ])
    await assert.rejects(runScript(code, { variables: {} }), pattern);
});

test("timers do not grant network access and cancellation interrupts timer waits", async () => {
  await assert.rejects(
    runScript(
      "setTimeout(()=>pm.sendRequest('https://example.test',()=>{}),0)",
      { variables: {} },
    ),
    /未启用HTTP/,
  );
  const controller = new AbortController();
  const pending = runScript(
    "setTimeout(()=>{apt.setVar('late',true)},1000)",
    { variables: {} },
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, /取消/);
});

test("timer and HTTP callbacks share one completion loop without early output", async (t) => {
  const server = http.createServer((req, res) => res.end('{"ok":true}'));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const result = await runScript(
    `pm.test('timer HTTP timer',done=>{
    setTimeout(()=>pm.sendRequest(${JSON.stringify(url)},(error,response)=>{
      if(error)return done(error);
      setTimeout(()=>{pm.expect(response.json().ok).to.equal(true);done()},0);
    }),0);
  });`,
    { variables: {}, allowNetwork: true },
  );
  assert.equal(result.tests[0].passed, true);
  assert.equal(result.networkRequests.length, 1);
});

test("nested waits cannot reset the parent total deadline or expose timer internals", async () => {
  const result = await runScript(
    "apt.setVar('internals',[typeof __scheduleTimer,typeof __cancelTimer,typeof setInterval]);",
    { variables: {} },
  );
  assert.deepEqual(result.variables.internals, [
    "undefined",
    "undefined",
    "undefined",
  ]);
  await assert.rejects(
    runScript(
      "setTimeout(()=>setTimeout(()=>setTimeout(()=>{},1000),1000),1000)",
      { variables: {} },
    ),
    /超时/,
  );
});
