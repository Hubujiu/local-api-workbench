import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runScript } from "../src/scripts.mjs";

async function fixture(t) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const parts = [];
    for await (const p of req) parts.push(p);
    requests.push({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: Buffer.concat(parts).toString(),
    });
    res.setHeader("content-type", "application/json");
    if (req.url === "/fail") res.statusCode = 400;
    if (req.url === "/empty") {
      res.statusCode = 204;
      res.end();
      return;
    }
    res.end(
      req.url === "/invalid"
        ? "not-json"
        : JSON.stringify({ token: "fixture-token" }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

test("ajax callbacks preserve JSON form and query payloads and finish before output", async (t) => {
  const f = await fixture(t);
  const result = await runScript(
    `
    $.ajax({url:${JSON.stringify(f.url + "/json")},method:'POST',contentType:'application/json',data:JSON.stringify({n:0}),success:(data,status,xhr)=>{
      apt.variables.set('token',data.token);apt.setVar('status',[status,xhr.status]);
    },complete:()=>apt.setVar('completed',true)});
    $.ajax({url:${JSON.stringify(f.url + "/form")},type:'POST',data:{zero:0,no:false,empty:null,name:'中 +文'},success:()=>{}});
    $.ajax({url:${JSON.stringify(f.url + "/query?existing=1#fragment")},data:{q:'a&b',zero:0},success:()=>{}});
  `,
    { variables: {}, allowNetwork: true },
  );
  assert.equal(result.scopes.environment.token, "fixture-token");
  assert.deepEqual(result.variables.status, ["success", 200]);
  assert.equal(result.variables.completed, true);
  assert.equal(result.networkRequests.length, 3);
  const json = f.requests.find((r) => r.url === "/json");
  assert.equal(json.body, '{"n":0}');
  assert.equal(json.headers["content-type"], "application/json");
  const form = f.requests.find((r) => r.url === "/form");
  assert.equal(form.body, "zero=0&no=false&empty=&name=%E4%B8%AD+%2B%E6%96%87");
  assert.match(
    form.headers["content-type"],
    /application\/x-www-form-urlencoded/,
  );
  assert.equal(
    f.requests.find((r) => r.url.startsWith("/query")).url,
    "/query?existing=1&q=a%26b&zero=0",
  );
});

test("ajax HTTP and parser errors call error/complete and unhandled failures reject", async (t) => {
  const f = await fixture(t);
  for (const [path, status, code] of [
    ["/fail", "error", 400],
    ["/invalid", "parsererror", 200],
  ]) {
    const result = await runScript(
      `$.ajax({url:${JSON.stringify(f.url + path)},success:()=>{throw Error('wrong success')},error:(xhr,status,error)=>apt.setVar('error',[xhr.status,status,Boolean(error)]),complete:(xhr,status)=>apt.setVar('complete',status)});`,
      { variables: {}, allowNetwork: true },
    );
    assert.deepEqual(result.variables.error, [code, status, true]);
    assert.equal(result.variables.complete, status);
    await assert.rejects(
      runScript(`$.ajax({url:${JSON.stringify(f.url + path)}});`, {
        variables: {},
        allowNetwork: true,
      }),
      /HTTP 400|JSON|Unexpected|unexpected/,
    );
  }
  await assert.rejects(
    runScript(
      `$.ajax({url:${JSON.stringify(f.url)},success:()=>{throw Error('callback failure')}});`,
      { variables: {}, allowNetwork: true },
    ),
    /callback failure/,
  );
});

test("ajax rejects unsupported settings and does not expand sandbox authority", async (t) => {
  const f = await fixture(t);
  for (const config of [
    "{url:'https://example.test',async:false}",
    "{url:'https://example.test',xhrFields:{}}",
    "{url:'https://example.test',data:{nested:{x:1}}}",
    "{url:'https://example.test',dataType:'script'}",
    "{url:'https://example.test',contentType:'application/json',data:{x:1}}",
  ])
    await assert.rejects(
      runScript(`$.ajax(${config.replaceAll("https://example.test", f.url)})`, {
        variables: {},
        allowNetwork: true,
      }),
      /ajax/,
    );
  await assert.rejects(
    runScript(`$.ajax({url:${JSON.stringify(f.url)}})`, { variables: {} }),
    /未启用HTTP/,
  );
  assert.equal(f.requests.length, 0);
});

test("ajax empty responses and text overrides retain their declared semantics", async (t) => {
  const f = await fixture(t);
  const empty = await runScript(
    `$.ajax({url:${JSON.stringify(f.url + "/empty")},dataType:'json',success:(data,status)=>apt.setVar('result',[typeof data,status])});`,
    { variables: {}, allowNetwork: true },
  );
  assert.deepEqual(empty.variables.result, ["undefined", "nocontent"]);
  const text = await runScript(
    `$.ajax({url:${JSON.stringify(f.url + "/invalid")},dataType:'text',success:data=>apt.setVar('text',data)});`,
    { variables: {}, allowNetwork: true },
  );
  assert.equal(text.variables.text, "not-json");
  const asyncResult = await runScript(
    `$.ajax({url:${JSON.stringify(f.url)},success:async()=>{await Promise.resolve();apt.setVar('asyncDone',true)}});`,
    { variables: {}, allowNetwork: true },
  );
  assert.equal(asyncResult.variables.asyncDone, true);
});

test("ajax awaits async success and completion in order without resetting budgets", async (t) => {
  const f = await fixture(t);
  const r = await runScript(
    `let order='';$.ajax({url:${JSON.stringify(f.url)},success:async()=>{await new Promise(r=>setTimeout(r,5));order+='success';},complete:async()=>{await Promise.resolve();apt.setVar('order',order+'-complete')}});`,
    { variables: {}, allowNetwork: true },
  );
  assert.equal(r.variables.order, "success-complete");
});
test("ajax async rejection preserves its original error even if completion rejects", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runScript(
      `$.ajax({url:${JSON.stringify(f.url)},success:async()=>{await Promise.resolve();throw Error('original-async-failure')},complete:async()=>{await Promise.resolve();throw Error('secondary-complete-failure')}});`,
      { variables: {}, allowNetwork: true },
    ),
    /original-async-failure/,
  );
});

test("ajax async handlers cannot hide undefined rejection or unfinished callbacks", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runScript(
      `$.ajax({url:${JSON.stringify(f.url)},success:async()=>{throw undefined}});`,
      { variables: {}, allowNetwork: true },
    ),
  );
  await assert.rejects(
    runScript(
      `$.ajax({url:${JSON.stringify(f.url)},complete:async()=>await new Promise(()=>{})});`,
      { variables: {}, allowNetwork: true },
    ),
    /未完成|超时|Promise/,
  );
  const handled = await runScript(
    `$.ajax({url:${JSON.stringify(f.url + "/fail")},error:async()=>{await Promise.resolve();apt.setVar('handled',true)},complete:async()=>{await Promise.resolve();apt.setVar('completed',true)}});`,
    { variables: {}, allowNetwork: true },
  );
  assert.equal(handled.variables.handled, true);
  assert.equal(handled.variables.completed, true);
});

test("ajax returned Promise can be awaited or caught without losing completion ordering", async (t) => {
  const f = await fixture(t);
  const r = await runScript(
    `const value=await $.ajax({url:${JSON.stringify(f.url + "/json")},dataType:'json',complete:async()=>{await Promise.resolve();apt.setVar('complete',true)}});apt.setVar('value',value);apt.setVar('awaitComplete',apt.getVar('complete'));try{await $.ajax({url:${JSON.stringify(f.url + "/fail")}})}catch(e){apt.setVar('caught',String(e))}`,
    { variables: {}, allowNetwork: true },
  );
  assert.equal(r.variables.awaitComplete, true);
  assert.equal(typeof r.variables.value, "object");
  assert.match(r.variables.caught, /HTTP 400/);
});
