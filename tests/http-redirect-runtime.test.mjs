import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import http2 from "node:http2";
import { gzipSync } from "node:zlib";
import { executeRequest } from "../src/runtime.mjs";
import {
  normalizeRedirect,
  readHttpRedirectFailure,
} from "../src/http-redirect.mjs";
import { memoryCookieSession } from "../src/cookie-jar.mjs";
const redirect = { mode: "same-origin" };
async function serve(t, handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const record = {
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: Buffer.concat(chunks),
    };
    requests.push(record);
    handler(record, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}
async function rejected(promise, reason, status) {
  let caught;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "must fail");
  const data = readHttpRedirectFailure(caught);
  assert.ok(data);
  assert.equal(data.failure.reason, reason);
  assert.equal(data.failure.retry_safe, false);
  if (status !== undefined) assert.equal(data.response.status, status);
  return data;
}
test("redirect strict shape is bounded and inert", () => {
  assert.equal(normalizeRedirect(undefined), undefined);
  assert.deepEqual(normalizeRedirect(redirect), {
    mode: "same-origin",
    maxHops: 5,
  });
  for (const value of [
    true,
    null,
    [],
    {},
    { mode: "all" },
    { mode: "same-origin", maxHops: 0 },
    { mode: "same-origin", maxHops: 6 },
    { mode: "same-origin", maxHops: "2" },
    { mode: "same-origin", extra: 1 },
    new Proxy({}, {}),
  ])
    assert.throws(() => normalizeRedirect(value));
  let called = 0;
  assert.throws(() =>
    normalizeRedirect({
      get mode() {
        called++;
        return "same-origin";
      },
    }),
  );
  assert.equal(called, 0);
});
test("default off and opt-in method/body matrix uses real HTTP", async (t) => {
  const f = await serve(t, (req, res) => {
    if (req.url.startsWith("/start")) {
      res.writeHead(
        Number(new URL(req.url, "http://x").searchParams.get("code")),
        { location: "/end" },
      );
      res.end("redirect");
    } else res.end("done");
  });
  for (const status of [301, 302, 303, 307, 308])
    for (const method of [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "HEAD",
      "OPTIONS",
    ]) {
      const count = f.requests.length;
      const off = await executeRequest({
        url: f.url + "/start?code=" + status,
        method,
        bodyType: "raw",
        body: "exact",
      });
      assert.equal(off.status, status);
      assert.equal(f.requests.length, count + 1);
      assert.equal(off.redirectTrace, undefined);
      const response = await executeRequest({
        url: f.url + "/start?code=" + status,
        method,
        bodyType: "raw",
        body: "exact",
        redirect,
      });
      const expected =
        status === 303
          ? method === "HEAD"
            ? "HEAD"
            : "GET"
          : [301, 302].includes(status) && method === "POST"
            ? "GET"
            : method;
      assert.equal(response.status, 200);
      assert.equal(f.requests.length, count + 3);
      assert.equal(f.requests.at(-1).method, expected);
      const dropped =
        status === 303 || ([301, 302].includes(status) && method === "POST");
      assert.equal(f.requests.at(-1).body.toString(), dropped ? "" : "exact");
      if (dropped)
        assert.equal(f.requests.at(-1).headers["content-length"], undefined);
      assert.equal(response.request.url, f.url + "/end");
      assert.equal(response.redirectTrace.length, 2);
    }
});
test("exact multipart and binary bytes are reused, query applied only first hop", async (t) => {
  const f = await serve(t, (req, res) => {
    if (req.url.startsWith("/start")) {
      res.writeHead(307, { location: "/end?x=%23&x=2#last" });
      res.end();
    } else res.end("done");
  });
  for (const definition of [
    { bodyType: "binary", body: Buffer.from([0, 255, 12]).toString("base64") },
    {
      bodyType: "form-data",
      form: [
        {
          key: "file",
          type: "file",
          filename: "x.bin",
          value: Buffer.from([0, 255]).toString("base64"),
        },
      ],
    },
  ]) {
    const response = await executeRequest({
      url: f.url + "/start#first",
      method: "POST",
      query: [{ key: "initial", value: "yes" }],
      ...definition,
      redirect,
    });
    const [a, b] = f.requests.slice(-2);
    assert.deepEqual(a.body, b.body);
    assert.equal(a.headers["content-type"], b.headers["content-type"]);
    assert.equal(a.url, "/start?initial=yes");
    assert.equal(b.url, "/end?x=%23&x=2");
    assert.equal(response.effectiveUrl, f.url + "/end?x=%23&x=2#last");
  }
});
test("cross-origin, duplicate Location, Retry-After, loop and hop budget fail with real response", async (t) => {
  const other = await serve(t, (_req, res) => res.end("must not hit"));
  const f = await serve(t, (req, res) => {
    const mode = req.url.split("/")[1];
    const location =
      mode === "origin"
        ? other.url
        : mode === "duplicate"
          ? ["/a", "/b"]
          : mode === "loop"
            ? "/loop"
            : "/hop/" + (Number(req.url.split("/")[2] || 0) + 1);
    res.writeHead(302, {
      location,
      ...(mode === "retry" ? { "retry-after": "1" } : {}),
    });
    res.end("actual302");
  });
  for (const [path, reason] of [
    ["origin", "origin"],
    ["duplicate", "location"],
    ["retry", "retry-after"],
    ["loop", "loop"],
    ["hop", "hops"],
  ]) {
    const d = await rejected(
      executeRequest({
        url: f.url + "/" + path,
        redirect: { ...redirect, maxHops: 2 },
      }),
      reason,
      302,
    );
    assert.equal(d.response.body, "actual302");
    assert.equal(d.failure.responseComplete, true);
  }
  assert.equal(other.requests.length, 0);
});
test("first and next-hop partial responses retain their actual HTTP status", async (t) => {
  const f = await serve(t, (req, res) => {
    if (req.url === "/first") {
      res.writeHead(302, { location: "/second" });
      res.end("first");
    } else {
      res.writeHead(req.url === "/second" ? 404 : 302, { location: "/never" });
      res.write("prefix");
      setTimeout(() => res.destroy(), 20);
    }
  });
  let d = await rejected(
    executeRequest({ url: f.url + "/partial", redirect }),
    "transport",
    302,
  );
  assert.equal(d.response.body, "prefix");
  assert.equal(d.failure.responseComplete, false);
  assert.equal(d.response.request.url, f.url + "/partial");
  d = await rejected(
    executeRequest({ url: f.url + "/first", redirect }),
    "transport",
    404,
  );
  assert.equal(d.response.body, "prefix");
  assert.equal(d.response.request.url, f.url + "/second");
  assert.equal(d.failure.responseComplete, false);
});
test("one deadline and cancellation stop partial responses without another hop", async (t) => {
  const f = await serve(t, (_req, res) => {
    res.writeHead(302, { location: "/never" });
    res.write("prefix");
  });
  const controller = new AbortController();
  const running = executeRequest(
    { url: f.url, redirect, timeout: 1000 },
    controller.signal,
  );
  setTimeout(() => controller.abort(), 50);
  let d = await rejected(running, "cancelled", 302);
  assert.equal(d.failure.responseComplete, false);
  d = await rejected(
    executeRequest({ url: f.url, redirect, timeout: 50 }),
    "timeout",
    302,
  );
  assert.equal(d.response.body, "prefix");
  assert.equal(f.requests.length, 2);
});
test("cumulative decoded response budget spans compressed hops", async (t) => {
  const content = Buffer.alloc(5 * 1024 * 1024, 65);
  const f = await serve(t, (req, res) => {
    res.writeHead(req.url === "/a" ? 302 : 200, {
      "content-encoding": "gzip",
      location: "/b",
    });
    res.end(gzipSync(content));
  });
  const d = await rejected(
    executeRequest({ url: f.url + "/a", redirect }),
    "response-budget",
    200,
  );
  assert.equal(d.failure.responseComplete, false);
  assert.equal(f.requests.length, 2);
});
test("manual cookie only first hop and managed cookies refresh each response", async (t) => {
  const f = await serve(t, (req, res) => {
    if (req.url === "/a") {
      res.writeHead(302, {
        location: "/b",
        "set-cookie": ["next=ok; Path=/b"],
      });
      res.end();
    } else res.end(req.headers.cookie || "none");
  });
  let r = await executeRequest({
    url: f.url + "/a",
    redirect,
    headers: [{ key: "Cookie", value: "manual=first" }],
  });
  assert.equal(f.requests.at(-2).headers.cookie, "manual=first");
  assert.equal(r.body, "none");
  r = await executeRequest({ url: f.url + "/a", redirect }, undefined, {
    cookieSession: memoryCookieSession({ enabled: true, cookies: [] }),
  });
  assert.equal(r.body, "next=ok");
});
test("unsupported auth and control headers reject before any connection", async (t) => {
  const f = await serve(t, (_req, res) => res.end());
  for (const auth of [
    { type: "digest" },
    { type: "apiKey", in: "query", key: "x", value: "secret" },
    { type: "apiKey", key: "Host", value: "other" },
    { type: "apiKey", key: "Cookie", value: "x" },
  ])
    await assert.rejects(executeRequest({ url: f.url, redirect, auth }));
  for (const key of ["Host", "Proxy-Authorization", "Content-Length"])
    await assert.rejects(
      executeRequest({ url: f.url, redirect, headers: [{ key, value: "x" }] }),
    );
  assert.equal(f.requests.length, 0);
});
test("HTTP2 per-hop connections follow actual path and expose original header pairs", async (t) => {
  const paths = [],
    sessions = new Set(),
    server = http2.createServer();
  server.on("session", (s) => sessions.add(s));
  server.on("stream", (stream, headers) => {
    paths.push(headers[":path"]);
    stream.respond({
      ":status": headers[":path"] === "/a" ? 302 : 200,
      ...(headers[":path"] === "/a" ? { location: "/b" } : {}),
    });
    stream.end("h2");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const s of sessions) s.destroy();
    server.close();
  });
  const r = await executeRequest({
    url: `http://127.0.0.1:${server.address().port}/a`,
    redirect,
    httpVersion: "2",
  });
  assert.equal(r.status, 200);
  assert.deepEqual(paths, ["/a", "/b"]);
});

test("next-hop failure before headers retains previous complete 302 without claiming a new response", async (t) => {
  const f = await serve(t, (req, res) => {
    if (req.url === "/a") {
      res.writeHead(302, { location: "/b" });
      res.end("previous-complete");
    } else res.destroy();
  });
  const d = await rejected(
    executeRequest({ url: f.url + "/a", redirect }),
    "transport",
    302,
  );
  assert.equal(d.response.body, "previous-complete");
  assert.equal(d.response.request.url, f.url + "/a");
  assert.equal(d.failure.attemptedUrl, f.url + "/b");
  assert.equal(d.failure.requestStarted, true);
  assert.equal(d.failure.responseComplete, true);
  assert.equal(f.requests.length, 2);
});
test("identity encoded budget accumulates across responses and prohibits another request", async (t) => {
  const bytes = Buffer.alloc(5 * 1024 * 1024, 66);
  const f = await serve(t, (_req, res) => {
    res.writeHead(302, { location: "/again" });
    res.end(bytes);
  });
  const d = await rejected(
    executeRequest({ url: f.url + "/first", redirect }),
    "response-budget",
    302,
  );
  assert.equal(d.failure.responseComplete, false);
  assert.equal(f.requests.length, 2);
  assert.ok(d.response.size <= 3 * 1024 * 1024);
});
test("intermediate cookie failure is terminal and final ordinary cookie failure remains a warning", async (t) => {
  const f = await serve(t, (req, res) => {
    res.writeHead(req.url === "/a" ? 302 : 200, {
      location: "/b",
      "set-cookie": "x=y",
    });
    res.end("actual");
  });
  const session = {
    header: async () => null,
    capture: async () => {
      throw Error("fixture disk unavailable");
    },
  };
  const d = await rejected(
    executeRequest({ url: f.url + "/a", redirect }, undefined, {
      cookieSession: session,
    }),
    "cookie",
    302,
  );
  assert.equal(d.failure.responseComplete, true);
  assert.equal(f.requests.length, 1);
  const r = await executeRequest(
    { url: f.url + "/final", redirect },
    undefined,
    { cookieSession: session },
  );
  assert.equal(r.status, 200);
  assert.match(r.cookieError, /Cookie/);
  assert.equal(f.requests.length, 2);
});
test("URL references retain empty/repeated queries and inherited fragments without template reinterpretation", async (t) => {
  const next = ["?next=1&next=2", "?", "/literal/{{not-a-template}}", "/done#"];
  let i = 0;
  const f = await serve(t, (_req, res) => {
    if (i < next.length) {
      res.writeHead(302, { location: next[i++] });
      res.end();
    } else res.end("done");
  });
  const r = await executeRequest({
    url: f.url + "/begin?old=1#keep",
    redirect,
  });
  assert.deepEqual(
    f.requests.map((x) => x.url),
    [
      "/begin?old=1",
      "/begin?next=1&next=2",
      "/begin?",
      "/literal/%7B%7Bnot-a-template%7D%7D",
      "/done",
    ],
  );
  assert.equal(r.effectiveUrl, f.url + "/done#");
});
test("msgpack final body retains normal decoding and 307 replays exact encoded bytes", async (t) => {
  const { encode } = await import("@msgpack/msgpack");
  const f = await serve(t, (req, res) => {
    if (req.url === "/a") {
      res.writeHead(307, { location: "/b" });
      res.end();
    } else {
      res.writeHead(200, { "content-type": "application/msgpack" });
      res.end(Buffer.from(encode({ answer: 42 })));
    }
  });
  const r = await executeRequest({
    url: f.url + "/a",
    method: "POST",
    bodyType: "msgpack",
    body: '{"x":7}',
    redirect,
  });
  assert.deepEqual(f.requests[0].body, f.requests[1].body);
  assert.deepEqual(JSON.parse(r.body), { answer: 42 });
  assert.equal(typeof r.rawBodyBase64, "string");
  assert.equal(Object.hasOwn(r, "_redirectRaw"), false);
});

test("HTTP1 parser saturation cannot hide Location or duplicate Location", async (t) => {
  const f = await serve(t, (_req, res) => {
    const fields = [];
    for (let i = 0; i < 1000; i++) fields.push("x" + i, "v");
    fields.push("Location", "/hidden");
    res.writeHead(302, fields);
    res.end("must not silently pass");
  });
  const d = await rejected(
    executeRequest({ url: f.url, redirect }),
    "header-limit",
    302,
  );
  assert.equal(d.failure.responseComplete, false);
  assert.equal(f.requests.length, 1);
});
test("late headers after cancellation do not replace evidence or invoke capture callback", async (t) => {
  const { executePreparedRedirect } = await import(
    "../src/http-redirect-transport.mjs"
  );
  const f = await serve(t, (_req, res) => {
    setTimeout(() => {
      res.writeHead(302, { location: "/late" });
      res.end("late");
    }, 50);
  });
  const controller = new AbortController();
  let captured = 0;
  const pending = executePreparedRedirect(
    {
      method: "GET",
      auth: { type: "none" },
      redirect: { ...redirect, maxHops: 2 },
    },
    new URL(f.url),
    {},
    undefined,
    { signal: controller.signal, deadline: performance.now() + 1000 },
    undefined,
    () => captured++,
  );
  setTimeout(() => controller.abort(), 15);
  const d = await rejected(pending, "cancelled");
  assert.equal(d.response, undefined);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(captured, 0);
  assert.equal(f.requests.length, 1);
});

test("internal evidence callback errors are contained as transport failure with actual partial response", async (t) => {
  const { executePreparedRedirect } = await import(
    "../src/http-redirect-transport.mjs"
  );
  const f = await serve(t, (_req, res) => {
    res.writeHead(200);
    res.end("actual");
  });
  const d = await rejected(
    executePreparedRedirect(
      {
        method: "GET",
        auth: { type: "none" },
        redirect: { ...redirect, maxHops: 2 },
      },
      new URL(f.url),
      {},
      undefined,
      { deadline: performance.now() + 1000 },
      undefined,
      () => {
        throw Error("internal evidence fixture");
      },
    ),
    "transport",
    200,
  );
  assert.equal(d.failure.responseComplete, false);
  assert.equal(f.requests.length, 1);
});

test("redirect generated authentication headers reject before proxy CONNECT and healthy header keys replay", async (t) => {
  let connects = 0;
  const sockets = new Set();
  const proxy = http.createServer();
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  proxy.on("connect", (_request, socket) => {
    connects++;
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => proxy.close(resolve));
  });
  for (const httpVersion of ["1.1", "2"])
    for (const auth of [
      { type: "apiKey", in: "header", key: "invalid name", value: "x" },
      { type: "apiKey", in: "header", key: "X-Key", value: "x\r\ny" },
      { type: "bearer", token: "x\r\ny" },
    ]) {
      await assert.rejects(
        executeRequest({
          url: "https://127.0.0.1:9/",
          redirect,
          httpVersion,
          auth,
          proxy: `http://127.0.0.1:${proxy.address().port}`,
          timeout: 1000,
        }),
        /header|token|character/i,
      );
      assert.equal(
        connects,
        0,
        "invalid generated headers must not open a proxy tunnel",
      );
    }
  const origin = await serve(t, (request, response) => {
    assert.equal(request.headers["x-fixture-key"], "healthy-value");
    if (request.url === "/first")
      response.writeHead(307, { location: "/final" });
    response.end("healthy");
  });
  const result = await executeRequest({
    url: origin.url + "/first",
    redirect,
    auth: {
      type: "apiKey",
      in: "header",
      key: "X-Fixture-Key",
      value: "healthy-value",
    },
  });
  assert.equal(result.status, 200);
  assert.equal(origin.requests.length, 2);
});
