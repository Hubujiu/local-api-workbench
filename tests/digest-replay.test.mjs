import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { executeRequest, Store } from "../src/runtime.mjs";
import { snapshotPlan, restoreProject } from "../src/core.mjs";
import { createApp } from "../src/server.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const executeCLI = promisify(execFile);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const auth = {
  type: "digest",
  username: "alice",
  password: "fictional-password",
};
const multipart = [
  { key: "message", value: "中 & text", type: "text" },
  { key: "message", value: "", type: "text" },
  {
    key: "upload",
    filename: "fixture.bin",
    value: Buffer.from([0, 255, 13, 10, 42]).toString("base64"),
    type: "file",
  },
];
async function origin(
  t,
  { requireCookie = false, finalDelay = 0, multipleChallenges = false } = {},
) {
  const requests = [],
    challenges = new Map(),
    failures = [];
  let sequence = 0;
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks),
        record = {
          body,
          headers: req.headers,
          method: req.method,
          url: req.url,
          socket: req.socket,
        };
      requests.push(record);
      if (!req.headers.authorization) {
        const nonce = "nonce-" + ++sequence;
        challenges.set(nonce, record);
        const challenge =
          'Digest realm="fixture", nonce="' +
          nonce +
          '", algorithm=SHA-256, qop="auth-int"';
        res.writeHead(401, {
          "WWW-Authenticate": multipleChallenges
            ? [
                'Basic realm="not-the-digest-realm"',
                challenge,
                'Bearer realm="also-not-digest"',
              ]
            : challenge,
          "Set-Cookie": "challenge=" + nonce + "; Path=/",
          Connection: "close",
        });
        return res.end("challenge");
      }
      const params = Object.fromEntries(
        [
          ...req.headers.authorization.matchAll(
            /([\w-]+)=(?:"([^"]*)"|([^,\s]+))/g,
          ),
        ].map((match) => [match[1], match[2] ?? match[3]]),
      );
      const first = challenges.get(params.nonce);
      const expectedPassword = req.url.startsWith("/other")
        ? "other-password"
        : auth.password;
      const expectedUser = req.url.startsWith("/other") ? "bob" : auth.username;
      // Independent server verifier over the actual received entity bytes.
      const identity = hash(expectedUser + ":fixture:" + expectedPassword);
      const entity = hash(req.method + ":" + req.url + ":" + hash(body));
      const expected = hash(
        [
          identity,
          params.nonce,
          params.nc,
          params.cnonce,
          "auth-int",
          entity,
        ].join(":"),
      );
      const valid =
        Boolean(first) &&
        params.username === expectedUser &&
        params.uri === req.url &&
        params.qop === "auth-int" &&
        params.response === expected &&
        (!requireCookie || req.headers.cookie === "challenge=" + params.nonce);
      record.first = first;
      record.valid = valid;
      if (finalDelay) await delay(finalDelay);
      if (res.destroyed) return;
      res.writeHead(valid ? 200 : 401, {
        "Content-Type": "application/json",
        "WWW-Authenticate":
          'Digest realm="fixture", nonce="' +
          params.nonce +
          '", algorithm=SHA-256, qop="auth-int"',
      });
      res.end(JSON.stringify({ valid, entityHash: hash(body) }));
    } catch (error) {
      failures.push(error);
      res.writeHead(500);
      res.end("fixture failure");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(failures, []);
  });
  return { url: "http://127.0.0.1:" + server.address().port, requests };
}
test("Digest auth-int replays exact multipart, binary, JSON and encoded entities across a closed challenge connection", async (t) => {
  const target = await origin(t);
  for (const input of [
    { bodyType: "json", body: '{"value":"中"}' },
    { bodyType: "msgpack", body: '{"value":1,"text":"中"}' },
    { bodyType: "raw", body: "plain\0中" },
    { bodyType: "none" },
    { bodyType: "form-data", form: multipart },
    { bodyType: "form-data", form: [] },
    {
      bodyType: "binary",
      body: Buffer.from([0, 255, 13, 10]).toString("base64"),
    },
    { bodyType: "urlencoded", form: [{ key: "x", value: "a b&中" }] },
  ]) {
    const request = {
      url: target.url + "/entity",
      method: "POST",
      auth,
      timeout: 2000,
      ...input,
    };
    const before = structuredClone(request),
      start = target.requests.length;
    const response = await executeRequest(request);
    assert.equal(response.status, 200, response.body);
    assert.equal(response.authHandshake.status, 401);
    assert.equal(target.requests.length - start, 2);
    const [first, second] = target.requests.slice(start);
    assert.deepEqual(second.body, first.body);
    assert.equal(second.headers["content-type"], first.headers["content-type"]);
    assert.equal(
      second.headers["content-length"],
      first.headers["content-length"],
    );
    assert.notEqual(
      second.socket,
      first.socket,
      "Connection: close must allow a new connection",
    );
    assert(second.valid);
    assert.deepEqual(request, before);
  }
});
test("concurrent Digest bodies and identities stay isolated and failed credentials do not loop", async (t) => {
  const target = await origin(t);
  const results = await Promise.all([
    executeRequest({
      url: target.url + "/first",
      method: "POST",
      bodyType: "form-data",
      form: multipart,
      auth,
    }),
    executeRequest({
      url: target.url + "/other",
      method: "POST",
      bodyType: "form-data",
      form: [{ key: "x", value: "different" }],
      auth: { type: "digest", username: "bob", password: "other-password" },
    }),
  ]);
  assert(results.every((result) => result.status === 200));
  for (const authenticated of target.requests.filter(
    (request) => request.headers.authorization,
  ))
    assert.deepEqual(authenticated.body, authenticated.first.body);
  const count = target.requests.length;
  const denied = await executeRequest({
    url: target.url + "/denied",
    method: "POST",
    bodyType: "form-data",
    form: multipart,
    auth: { ...auth, password: "wrong-fictional-password" },
  });
  assert.equal(denied.status, 401);
  assert.equal(target.requests.length - count, 2);
});
test("Digest refreshes challenge cookies but does not send a second request after cancellation or exhausted deadline", async (t) => {
  const target = await origin(t, { requireCookie: true });
  let cookie = null;
  const session = {
    header: async () => cookie,
    capture: async (_url, values) => {
      if (values) cookie = values[0].split(";")[0];
    },
  };
  assert.equal(
    (
      await executeRequest(
        {
          url: target.url + "/cookies",
          method: "POST",
          bodyType: "form-data",
          form: multipart,
          auth,
        },
        undefined,
        { cookieSession: session },
      )
    ).status,
    200,
  );
  for (const mode of ["abort", "deadline"]) {
    const controller = new AbortController(),
      count = target.requests.length;
    await assert.rejects(
      executeRequest(
        {
          url: target.url + "/" + mode,
          method: "POST",
          bodyType: "form-data",
          form: multipart,
          auth,
          timeout: 100,
        },
        controller.signal,
        {
          cookieSession: {
            header: async () => null,
            capture: async () => {
              if (mode === "abort") controller.abort();
              else await delay(130);
            },
          },
        },
      ),
      mode === "abort" ? /abort|取消/i : /超时/,
    );
    assert.equal(target.requests.length - count, 1);
  }
});

test("Digest proxy retry carries the authenticated header and the original entity", async (t) => {
  const target = await origin(t);
  const seen = [],
    failures = [];
  const proxy = http.createServer((req, res) => {
    seen.push({
      url: req.url,
      authorization: req.headers.authorization,
      proxyAuthorization: req.headers["proxy-authorization"],
    });
    const destination = new URL(req.url);
    const headers = { ...req.headers };
    delete headers["proxy-authorization"];
    const outgoing = http.request(
      destination,
      { method: req.method, headers },
      (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      },
    );
    outgoing.on("error", (error) => {
      failures.push(error);
      res.writeHead(502);
      res.end();
    });
    req.pipe(outgoing);
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
    assert.deepEqual(failures, []);
  });
  const result = await executeRequest({
    url: target.url + "/proxy?original=yes",
    method: "POST",
    query: [{ key: "q", value: "a b" }],
    bodyType: "form-data",
    form: multipart,
    auth,
    proxy: "http://proxy-user:proxy-fixture@127.0.0.1:" + proxy.address().port,
  });
  assert.equal(result.status, 200, result.body);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].authorization, undefined);
  assert.match(seen[1].authorization, /^Digest /);
  assert(
    seen.every(
      (request) =>
        request.proxyAuthorization ===
        "Basic " + Buffer.from("proxy-user:proxy-fixture").toString("base64"),
    ),
  );
  assert(
    target.requests.every(
      (request) => request.headers["proxy-authorization"] === undefined,
    ),
  );
  assert.deepEqual(target.requests[1].body, target.requests[0].body);
});

for (const multipleChallenges of [false, true])
  test(
    `Digest ${multipleChallenges ? "multi-challenge" : "single-challenge"} plan and real CLI freeze auth across save restore and restart`,
    { timeout: 30000 },
    async (t) => {
      const target = await origin(t, { multipleChallenges });
      const root = await mkdtemp(path.join(tmpdir(), "digest-plan-"));
      let app = await createApp({ root, port: 0 });
      t.after(async () => {
        app.server.closeAllConnections();
        await new Promise((resolve) => app.server.close(resolve));
        await rm(root, { recursive: true, force: true });
      });
      const p = await app.store.create("Digest workflow");
      p.requests = [
        {
          id: "digest",
          name: "Digest multipart",
          url: target.url + "/persisted",
          method: "POST",
          bodyType: "form-data",
          form: multipart,
          auth,
          timeout: 2000,
        },
      ];
      p.plans = [
        snapshotPlan({
          id: "plan",
          name: "Digest plan",
          steps: [{ request: p.requests[0] }],
        }),
      ];
      await app.store.save(p);
      const original = structuredClone((await app.store.get(p.id)).requests);
      const run = async (project) => {
        const response = await fetch(
          app.url + "/api/projects/" + project.id + "/run",
          {
            method: "POST",
            headers: {
              "x-local-token": app.token,
              "content-type": "application/json",
            },
            body: JSON.stringify({ planId: project.plans[0].id }),
          },
        );
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(result.status, "passed", JSON.stringify(result));
        assert.equal(result.recordSaved, true);
        assert.equal(result.results[0].response.status, 200);
        assert.equal(JSON.parse(result.results[0].response.body).valid, true);
        assert.equal(result.results[0].response.authHandshake.status, 401);
        assert(
          (await new Store(root).get(project.id)).runs.some(
            (record) => record.id === result.id && record.status === "passed",
          ),
        );
      };
      await run(p);
      const stored = await app.store.get(p.id);
      const restored = restoreProject(stored);
      await app.store.save(restored);
      await run(restored);
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
      app = await createApp({ root, port: 0 });
      await run(await app.store.get(p.id));
      await run(await app.store.get(restored.id));
      assert.deepEqual((await app.store.get(p.id)).requests, original);
      const edited = await app.store.get(p.id);
      const frozenPlan = structuredClone(edited.plans[0]);
      edited.requests[0].auth.password = "changed-live-fixture-password";
      edited.requests[0].url = target.url + "/changed-live-definition";
      await app.store.save(edited);
      for (const projectId of [p.id, restored.id]) {
        const { stdout } = await executeCLI(
          process.execPath,
          ["scripts/run-plan.mjs", "--project", projectId, "--plan", "plan"],
          {
            cwd: fileURLToPath(new URL("..", import.meta.url)),
            env: { ...process.env, LOCAL_API_DATA: root },
            timeout: 15000,
            maxBuffer: 1024 * 1024,
          },
        );
        const result = JSON.parse(stdout);
        assert.equal(result.status, "passed");
        assert.equal(result.recordSaved, true);
        const saved = await new Store(root).get(projectId);
        const record = saved.runs.find((run) => run.id === result.id);
        assert(record);
        assert.equal(record.source, "cli");
        assert.equal(record.results[0].response.status, 200);
        assert.equal(JSON.parse(record.results[0].response.body).valid, true);
        assert.equal(record.results[0].response.authHandshake.status, 401);
        assert.deepEqual(saved.plans[0], frozenPlan);
      }
      assert.equal(target.requests.length, 12);
      assert(
        target.requests.every(
          (request) =>
            request.url === "/persisted" && request.method === "POST",
        ),
      );
      assert(
        target.requests
          .filter((request) => request.headers.authorization)
          .every((request) => request.valid === true),
      );
      const initial = target.requests.filter(
        (request) => !request.headers.authorization,
      );
      assert.equal(
        new Set(initial.map((request) => request.headers["content-type"])).size,
        6,
        "separate owner and CLI executions must not share prepared bodies",
      );
      for (const request of target.requests.filter(
        (request) => request.headers.authorization,
      ))
        assert.deepEqual(request.body, request.first.body);
      for (const projectId of [p.id, restored.id]) {
        const saved = await app.store.get(projectId);
        const definitions = JSON.stringify({
          requests: saved.requests,
          plans: saved.plans,
          snapshots: saved.runs.map((run) => run.snapshot),
        });
        for (const request of initial)
          assert(!definitions.includes(request.headers["content-type"]));
        // Wire evidence intentionally retains transmitted headers/body for debugging.
        for (const run of saved.runs)
          assert.match(
            run.results[0].response.request.headers["content-type"],
            /^multipart\/form-data; boundary=/,
          );
      }
    },
  );

test("Digest authenticated retry keeps the original deadline even below normalized minimum timeout", async (t) => {
  const target = await origin(t, { finalDelay: 80 });
  await assert.rejects(
    executeRequest(
      {
        url: target.url + "/deadline",
        method: "POST",
        bodyType: "form-data",
        form: multipart,
        auth,
        timeout: 200,
      },
      undefined,
      {
        cookieSession: {
          header: async () => null,
          capture: async () => {
            await delay(140);
          },
        },
      },
    ),
    /超时/,
  );
  assert(
    target.requests.length <= 2,
    "a timeout must never trigger another replay",
  );
});
