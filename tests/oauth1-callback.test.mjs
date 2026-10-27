import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OAuth1Manager } from "../src/oauth1-flow.mjs";
import { createApp } from "../src/server.mjs";
import { executeRequest } from "../src/runtime.mjs";

const encode = (value) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
const decodeAuth = (header) =>
  Object.fromEntries(
    [...(header || "").matchAll(/(oauth_\w+)="([^"]*)"/g)].map(
      ([, key, value]) => [key, decodeURIComponent(value)],
    ),
  );
function signature(base, req, auth, secret) {
  const params = { ...auth };
  delete params.oauth_signature;
  const normalized = Object.entries(params)
    .map(([k, v]) => [encode(k), encode(v)])
    .sort(([ak, av], [bk, bv]) =>
      ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
    )
    .map(([k, v]) => k + "=" + v)
    .join("&");
  return createHmac("sha1", "client-secret&" + encode(secret))
    .update([req.method, base + req.url, normalized].map(encode).join("&"))
    .digest("base64");
}
async function fixture(t, options = {}) {
  const requests = [],
    accesses = [],
    resources = [],
    temporary = new Map();
  let serial = 0,
    base;
  const sockets = new Set();
  const provider = http.createServer(async (req, res) => {
    const auth = decodeAuth(req.headers.authorization);
    const key =
      req.url === "/request"
        ? ""
        : req.url === "/access"
          ? temporary.get(auth.oauth_token)?.secret
          : "access-secret";
    const record = {
      req,
      res,
      auth,
      signatureValid:
        key !== undefined &&
        signature(base, req, auth, key) === auth.oauth_signature,
    };
    if (req.url === "/request") {
      requests.push(record);
      if (options.request) return options.request(record);
      const n = ++serial,
        token = `temporary-${n}+ /汉`,
        secret = `temp-secret-${n}`;
      temporary.set(token, { n, secret });
      res.end(
        new URLSearchParams({
          oauth_token: token,
          oauth_token_secret: secret,
          oauth_callback_confirmed: "true",
        }).toString(),
      );
    } else if (req.url === "/access") {
      accesses.push(record);
      if (options.access) return options.access(record);
      res.end(
        new URLSearchParams({
          oauth_token: "access-" + temporary.get(auth.oauth_token)?.n,
          oauth_token_secret: "access-secret",
        }).toString(),
      );
    } else {
      resources.push(record);
      res.end("protected");
    }
  });
  provider.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((r) => provider.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${provider.address().port}`;
  const root = await mkdtemp(path.join(os.tmpdir(), "oauth1-callback-"));
  const app = await createApp({ root, port: 0 });
  const config = {
    consumerKey: "client",
    consumerSecret: "client-secret",
    callbackMode: "loopback",
    requestTokenEndpoint: base + "/request",
    authorizationEndpoint: base + "/authorize",
    tokenEndpoint: base + "/access",
  };
  const owner = async (endpoint, data, extra = {}) =>
    fetch(app.url + "/api/oauth1/" + endpoint, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        "x-local-token": app.token,
        ...(data === undefined ? {} : { "content-type": "application/json" }),
        ...extra,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  t.after(async () => {
    await new Promise((r) => app.server.close(r));
    for (const socket of sockets) socket.destroy();
    await new Promise((r) => provider.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const start = async (overrides = {}) => {
    const response = await owner("start", { ...config, ...overrides });
    assert.equal(response.status, 200);
    return response.json();
  };
  return {
    app,
    root,
    provider,
    config,
    owner,
    start,
    requests,
    accesses,
    resources,
    temporary,
  };
}
const redirect = (flow, verifier = "verify + /汉") => {
  const u = new URL(flow.redirectUri);
  u.searchParams.set(
    "oauth_token",
    new URL(flow.authorizationUrl).searchParams.get("oauth_token"),
  );
  u.searchParams.set("oauth_verifier", verifier);
  return u;
};
async function stored(root) {
  const files = await readdir(root, { recursive: true, withFileTypes: true });
  const data = {};
  for (const file of files.filter((f) => f.isFile())) {
    const full = path.join(file.parentPath, file.name);
    data[path.relative(root, full)] = await readFile(full, "utf8");
  }
  return data;
}
const until = async (predicate) => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw Error("Fixture condition timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("owned loopback callback signs both exchanges, hides secrets, and consumes owner result once without saving", async (t) => {
  const f = await fixture(t),
    before = await stored(f.root);
  const flow = await new Promise((resolve, reject) => {
    const req = http.request(
      f.app.url + "/api/oauth1/start",
      {
        method: "POST",
        headers: {
          host: `localhost:${f.app.server.address().port}`,
          "x-local-token": f.app.token,
          "content-type": "application/json",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            assert.equal(res.statusCode, 200);
            resolve(JSON.parse(Buffer.concat(chunks)));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(f.config));
  });
  assert.equal(new URL(flow.redirectUri).origin, f.app.url);
  assert.match(
    new URL(flow.redirectUri).pathname,
    /^\/oauth1\/callback\/[a-f0-9]{48}$/,
  );
  assert.notEqual(
    new URL(flow.redirectUri).pathname.split("/").at(-1),
    flow.id,
  );
  assert.equal(f.requests[0].auth.oauth_callback, flow.redirectUri);
  assert(f.requests[0].signatureValid);
  assert(!JSON.stringify(flow).includes("secret"));
  assert(!JSON.stringify(flow).includes(f.app.token));
  assert(f.app.oauthAllowed(flow.authorizationUrl));
  assert.equal((await f.owner("complete", { id: flow.id })).status, 400);
  assert.equal(
    (await (await f.owner("status/" + flow.id)).json()).status,
    "pending",
  );
  const callback = await fetch(redirect(flow));
  assert.equal(callback.status, 200);
  assert.equal(callback.headers.get("cache-control"), "no-store");
  assert.equal(callback.headers.get("referrer-policy"), "no-referrer");
  const text = await callback.text();
  for (const secret of ["verify", "temporary", "access-secret", f.app.token])
    assert(!text.includes(secret));
  assert.equal(f.accesses.length, 1);
  assert(f.accesses[0].signatureValid);
  assert.equal(f.accesses[0].auth.oauth_verifier, "verify + /汉");
  assert.equal(f.app.oauthAllowed(flow.authorizationUrl), false);
  assert.deepEqual(
    Object.keys(await (await f.owner("status/" + flow.id)).json()).sort(),
    ["expiresAt", "status"],
  );
  assert.equal((await fetch(redirect(flow))).status, 400);
  const result = await (await f.owner("complete", { id: flow.id })).json();
  assert.deepEqual(result, {
    accessToken: "access-1",
    tokenSecret: "access-secret",
  });
  assert.equal((await f.owner("complete", { id: flow.id })).status, 400);
  assert.equal((await f.owner("status/" + flow.id)).status, 400);
  assert.equal(f.accesses.length, 1);
  const protectedResponse = await executeRequest({
    url: f.config.tokenEndpoint.replace("/access", "/resource"),
    method: "GET",
    auth: {
      type: "oauth1",
      consumerKey: "client",
      consumerSecret: "client-secret",
      ...result,
    },
  });
  assert.equal(protectedResponse.body, "protected");
  assert(f.resources[0].signatureValid);
  assert.deepEqual(await stored(f.root), before);
});

test("malformed, duplicate, mismatched and wrong-method callbacks do no exchange and leave valid flow pending", async (t) => {
  const f = await fixture(t),
    flow = await f.start(),
    valid = redirect(flow);
  const cases = [
    "",
    "?oauth_token=wrong&oauth_verifier=v",
    "?oauth_token=x",
    valid.search + "&oauth_token=again",
    valid.search + "&oauth_verifier=again",
    valid.search + "&extra=x",
    "?oauth_token=%GG&oauth_verifier=v",
    "?oauth_token=%FF&oauth_verifier=v",
    valid.search.replace(/oauth_verifier=.*/, "oauth_verifier="),
    valid.search.replace(/oauth_verifier=.*/, "oauth_verifier=%0A"),
  ];
  for (const query of cases) {
    const response = await fetch(flow.redirectUri + query);
    assert.equal(response.status, 400);
    assert.equal(
      await response.text(),
      "OAuth1 callback failed or expired. Return to Local API Workbench.",
    );
    assert.equal(
      (await (await f.owner("status/" + flow.id)).json()).status,
      "pending",
    );
  }
  assert.equal((await fetch(valid, { method: "POST" })).status, 405);
  assert.equal(f.accesses.length, 0);
  assert.equal((await fetch(valid)).status, 200);
  assert.equal(f.accesses.length, 1);
});

test("flow isolation, explicit cancellation and replay do not modify independent projects", async (t) => {
  const f = await fixture(t);
  const a = await f.app.store.create("A"),
    b = await f.app.store.create("B");
  const before = await stored(f.root);
  const [first, second] = await Promise.all([f.start(), f.start()]);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.redirectUri, second.redirectUri);
  const wrong = redirect(first);
  wrong.searchParams.set(
    "oauth_token",
    new URL(second.authorizationUrl).searchParams.get("oauth_token"),
  );
  assert.equal((await fetch(wrong)).status, 400);
  assert.equal((await fetch(redirect(second))).status, 200);
  assert.equal((await f.owner("cancel", { id: first.id })).status, 200);
  assert.equal((await fetch(redirect(first))).status, 400);
  assert.equal((await f.owner("status/" + first.id)).status, 400);
  const access = await (await f.owner("complete", { id: second.id })).json();
  assert.equal(access.accessToken, "access-2");
  assert.equal(f.accesses.length, 1);
  assert.deepEqual(await stored(f.root), before);
  assert.equal((await f.app.store.get(a.id)).name, "A");
  assert.equal((await f.app.store.get(b.id)).name, "B");
});

test("management endpoints retain local-token, Host and Origin checks; callback never accepts a foreign absolute target", async (t) => {
  const f = await fixture(t),
    flow = await f.start();
  for (const [endpoint, method] of [
    ["start", "POST"],
    ["complete", "POST"],
    ["cancel", "POST"],
    ["status/" + flow.id, "GET"],
  ]) {
    const response = await fetch(f.app.url + "/api/oauth1/" + endpoint, {
      method,
    });
    assert.equal(response.status, 403);
    assert.equal(
      (
        await f.owner(endpoint, method === "POST" ? {} : undefined, {
          origin: "https://foreign.invalid",
        })
      ).status,
      403,
    );
    const badHost = await new Promise((resolve, reject) => {
      const req = http.request(
        f.app.url + "/api/oauth1/" + endpoint,
        {
          method,
          headers: { host: "foreign.invalid", "x-local-token": f.app.token },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.end(method === "POST" ? "{}" : undefined);
    });
    assert.equal(badHost, 403);
  }
  const callback = redirect(flow);
  const raw = await new Promise((resolve, reject) => {
    const req = http.request(
      f.app.url,
      { path: "http://foreign.invalid" + callback.pathname + callback.search },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(raw, 400);
  assert.equal(f.accesses.length, 0);
  assert.equal((await fetch(callback)).status, 200);
});

test("strict callback mode and owned origin validation reject before provider I/O; omitted mode stays OOB", async (t) => {
  const f = await fixture(t),
    manager = new OAuth1Manager();
  t.after(() => manager.close());
  for (const callbackMode of [null, false, "", "redirect", {}, []])
    await assert.rejects(
      manager.start({ ...f.config, callbackMode }, f.app.url),
      /模式/,
    );
  for (const origin of [
    undefined,
    "http://localhost:1234",
    "https://127.0.0.1:1234",
    "http://127.0.0.1:0",
    "http://127.0.0.1:65536",
    f.app.url + "/x",
  ])
    await assert.rejects(manager.start(f.config, origin), /本机/);
  assert.equal(f.requests.length, 0);
  const legacy = await manager.start({ ...f.config, callbackMode: undefined });
  assert.equal(f.requests[0].auth.oauth_callback, "oob");
  assert.equal(legacy.redirectUri, undefined);
  const result = await manager.complete({ id: legacy.id, verifier: "pin" });
  assert.equal(result.accessToken, "access-1");
});

test("concurrent callback replay issues one token POST; provider failure is fixed/redacted and consumes callback", async (t) => {
  let release;
  const f = await fixture(t, {
    access: ({ res }) => {
      release = () => {
        res.writeHead(500);
        res.end("provider-secret-verifier");
      };
    },
  });
  const flow = await f.start();
  const first = fetch(redirect(flow));
  await until(() => f.accesses.length === 1);
  assert.equal((await fetch(redirect(flow))).status, 400);
  assert.equal(
    (await f.owner("status/" + flow.id).then((r) => r.json())).status,
    "exchanging",
  );
  release();
  const response = await first;
  assert.equal(response.status, 400);
  assert(!(await response.text()).includes("provider-secret"));
  const status = await (await f.owner("status/" + flow.id)).json();
  assert.equal(status.status, "error");
  assert.equal(status.error, "OAuth1令牌交换失败");
  assert.equal((await fetch(redirect(flow))).status, 400);
  assert.equal((await f.owner("complete", { id: flow.id })).status, 400);
  assert.equal(f.accesses.length, 1);
});

test("cancel aborts the actual pending token socket and late provider completion cannot restore flow", async (t) => {
  let closed = false,
    late;
  const f = await fixture(t, {
    access: ({ req, res }) => {
      req.socket.once("close", () => {
        closed = true;
      });
      late = () => res.end("oauth_token=late&oauth_token_secret=late-secret");
    },
  });
  const flow = await f.start(),
    pending = fetch(redirect(flow));
  await until(() => f.accesses.length === 1);
  assert.equal((await f.owner("cancel", { id: flow.id })).status, 200);
  assert.equal((await pending).status, 400);
  await until(() => closed);
  late();
  assert.equal((await f.owner("status/" + flow.id)).status, 400);
  assert.equal((await f.owner("complete", { id: flow.id })).status, 400);
  assert.equal((await fetch(redirect(flow))).status, 400);
  assert.equal(f.accesses.length, 1);
});

test("callback disconnect aborts its owned provider request but unrelated flow still completes", async (t) => {
  let closed = false;
  const f = await fixture(t, {
    access: ({ req, res, auth }) => {
      if (auth.oauth_verifier === "hold")
        req.socket.once("close", () => {
          closed = true;
        });
      else res.end("oauth_token=other&oauth_token_secret=other-secret");
    },
  });
  const first = await f.start(),
    second = await f.start();
  const request = http.get(redirect(first, "hold"));
  request.on("error", () => {});
  await until(() => f.accesses.length === 1);
  request.destroy();
  await until(() => closed);
  assert.equal((await f.owner("status/" + first.id)).status, 400);
  assert.equal((await fetch(redirect(second, "ok"))).status, 200);
  assert.deepEqual(
    await (await f.owner("complete", { id: second.id })).json(),
    { accessToken: "other", tokenSecret: "other-secret" },
  );
});

test("owner request-token disconnect and server shutdown close provider sockets and prevent late start", async (t) => {
  let closed = 0;
  const f = await fixture(t, {
    request: ({ req }) =>
      req.socket.once("close", () => {
        closed++;
      }),
  });
  const owner = http.request(f.app.url + "/api/oauth1/start", {
    method: "POST",
    headers: {
      "x-local-token": f.app.token,
      "content-type": "application/json",
    },
  });
  owner.on("error", () => {});
  owner.end(JSON.stringify(f.config));
  await until(() => f.requests.length === 1);
  owner.destroy();
  await until(() => closed === 1);
  const pending = f.owner("start", f.config);
  await until(() => f.requests.length === 2);
  await new Promise((r) => f.app.server.close(r));
  assert.equal((await pending).status, 400);
  await until(() => closed === 2);
});

test("expiry, capacity and closed manager discard temporary/result state; fresh manager cannot resume flow", async (t) => {
  const f = await fixture(t),
    manager = new OAuth1Manager();
  t.after(() => manager.close());
  const flow = await manager.start(f.config, f.app.url);
  manager.flows.get(flow.id).expiresAt = Date.now() - 1;
  await assert.rejects(
    manager.callback(new URL(flow.redirectUri).pathname, redirect(flow).search),
    /过期/,
  );
  assert.equal(manager.flows.size, 0);
  for (let i = 0; i < 10; i++) await manager.start(f.config, f.app.url);
  await assert.rejects(manager.start(f.config, f.app.url), /过多/);
  const ids = [...manager.flows.keys()];
  manager.cancel(ids[0]);
  const replacement = await manager.start(f.config, f.app.url);
  const fresh = new OAuth1Manager();
  await assert.rejects(
    fresh.callback(
      new URL(replacement.redirectUri).pathname,
      redirect(replacement).search,
    ),
    /过期/,
  );
  fresh.close();
  manager.close();
  assert.equal(manager.flows.size, 0);
  await assert.rejects(manager.start(f.config, f.app.url), /关闭/);
  await assert.rejects(manager.complete({ id: replacement.id }), /关闭/);
});

test("request-token errors release capacity and never permit an unconfirmed callback", async (t) => {
  let payload =
      "oauth_token=temp&oauth_token_secret=secret&oauth_callback_confirmed=false",
    status = 200;
  const f = await fixture(t, {
    request: ({ res }) => {
      res.writeHead(status);
      res.end(payload);
    },
  });
  const manager = new OAuth1Manager();
  t.after(() => manager.close());
  for (const data of [
    payload,
    "oauth_token=t&oauth_token=t2&oauth_token_secret=s&oauth_callback_confirmed=true",
    "oauth_token=t&oauth_callback_confirmed=true",
  ]) {
    payload = data;
    await assert.rejects(manager.start(f.config, f.app.url));
    assert.equal(manager.flows.size, 0);
  }
  status = 500;
  payload = "private-provider-secret";
  await assert.rejects(
    manager.start(f.config, f.app.url),
    (error) => !error.message.includes(payload),
  );
  assert.equal(manager.flows.size, 0);
  assert.equal(f.accesses.length, 0);
});

test("expiry during token exchange aborts real transport and cannot resurrect expired state", async (t) => {
  let closed = false;
  const f = await fixture(t, {
    access: ({ req }) =>
      req.socket.once("close", () => {
        closed = true;
      }),
  });
  const manager = new OAuth1Manager();
  t.after(() => manager.close());
  const flow = await manager.start(f.config, f.app.url);
  const pending = manager.callback(
    new URL(flow.redirectUri).pathname,
    redirect(flow).search,
  );
  const rejected = assert.rejects(pending);
  await until(() => f.accesses.length === 1);
  manager.flows.get(flow.id).expiresAt = Date.now() - 1;
  manager.prune();
  await rejected;
  await until(() => closed);
  assert.equal(manager.flows.size, 0);
  await assert.rejects(manager.complete({ id: flow.id }), /过期/);
});

test("server shutdown cancels an inflight callback and restart cannot recover its verifier or result", async (t) => {
  let closed = false;
  const f = await fixture(t, {
    access: ({ req }) =>
      req.socket.once("close", () => {
        closed = true;
      }),
  });
  const flow = await f.start(),
    pending = fetch(redirect(flow));
  await until(() => f.accesses.length === 1);
  await new Promise((r) => f.app.server.close(r));
  assert.equal((await pending).status, 400);
  await until(() => closed);
  const restarted = await createApp({ root: f.root, port: 0 });
  t.after(() => new Promise((r) => restarted.server.close(r)));
  const callback = redirect(flow);
  callback.port = String(restarted.server.address().port);
  assert.equal((await fetch(callback)).status, 400);
  const response = await fetch(restarted.url + "/api/oauth1/complete", {
    method: "POST",
    headers: {
      "x-local-token": restarted.token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ id: flow.id }),
  });
  assert.equal(response.status, 400);
  assert.equal(f.accesses.length, 1);
});

test(
  "the existing 15 second token-exchange deadline is total and closes a held provider socket",
  { timeout: 22000 },
  async (t) => {
    let closed = false;
    const f = await fixture(t, {
      access: ({ req }) =>
        req.socket.once("close", () => {
          closed = true;
        }),
    });
    const flow = await f.start(),
      start = performance.now();
    const response = await fetch(redirect(flow));
    const elapsed = performance.now() - start;
    assert.equal(response.status, 400);
    assert(
      elapsed >= 14000 && elapsed < 20000,
      `fixed deadline elapsed ${elapsed}`,
    );
    await until(() => closed);
    assert.equal(
      (await (await f.owner("status/" + flow.id)).json()).status,
      "error",
    );
    assert.equal((await fetch(redirect(flow))).status, 400);
    assert.equal(f.accesses.length, 1);
  },
);
