// Pure policy/selection checks plus real HTTP boundary fixtures for ordinary CI.
// No production signer is used as the independent Digest verification oracle.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { digestChallengePolicy, digestAuthorization } from "../src/digest.mjs";
import { validateAuth, authTypes } from "../public/auth-model.js";
import { executeRequest } from "../src/runtime.mjs";
import { normalizeRequest, runPlan } from "../src/core.mjs";

const algorithms = [
  "MD5",
  "MD5-sess",
  "SHA-256",
  "SHA-256-sess",
  "SHA-512-256",
  "SHA-512-256-sess",
];
const secret = "FICTIONAL_DIGEST_PASSWORD_MUST_NOT_ECHO";
const marker = "FICTIONAL_POLICY_KEY_MUST_NOT_ECHO";
const credentials = { type: "digest", username: "alice", password: secret };
const auth = (algorithm = "SHA-256", retry = true) => ({
  ...credentials,
  challengePolicy: { algorithm, retry },
});
const offer = (
  algorithm = "SHA-256",
  qop = "auth",
  nonce = "fictional-nonce",
) =>
  `Digest realm="fixture", nonce="${nonce}", algorithm=${algorithm}${qop == null ? "" : `, qop="${qop}"`}`;
const descriptors = (value) =>
  Reflect.ownKeys(value).map((key) => [
    key,
    Object.getOwnPropertyDescriptor(value, key),
  ]);
function redacted(error) {
  assert.ok(error instanceof Error);
  for (const value of [secret, marker, "FICTIONAL_CHALLENGE_PRIVATE_NONCE"]) {
    assert.equal(String(error).includes(value), false);
    assert.equal(String(error.stack).includes(value), false);
    assert.equal(JSON.stringify(error).includes(value), false);
  }
  assert.equal(Object.hasOwn(error, "cause"), false);
  return true;
}
function parseAuthorization(value) {
  assert.match(value, /^Digest /);
  return Object.fromEntries(
    [...value.matchAll(/([\w-]+)=(?:"((?:\\.|[^"\\])*)"|([^,\s]+))/g)].map(
      (m) => [m[1], m[2] === undefined ? m[3] : m[2].replace(/\\(.)/g, "$1")],
    ),
  );
}
function verify(
  value,
  {
    algorithm,
    username = "alice",
    password = secret,
    method = "GET",
    uri = "/",
    body = Buffer.alloc(0),
    qop = "auth",
    nonce = "fictional-nonce",
  },
) {
  const p = parseAuthorization(value),
    normalized = algorithm.toUpperCase();
  const hashName = {
    MD5: "md5",
    "SHA-256": "sha256",
    "SHA-512-256": "sha512-256",
  }[normalized.replace(/-SESS$/, "")];
  const hash = (bytes) => createHash(hashName).update(bytes).digest("hex");
  let identity = hash(`${username}:fixture:${password}`);
  if (normalized.endsWith("-SESS"))
    identity = hash(`${identity}:${nonce}:${p.cnonce}`);
  const entity = hash(
    `${method}:${uri}${qop === "auth-int" ? ":" + hash(body) : ""}`,
  );
  const expected = hash(
    qop
      ? [identity, nonce, "00000001", p.cnonce, qop, entity].join(":")
      : [identity, nonce, entity].join(":"),
  );
  assert.equal(p.username, username);
  assert.equal(p.realm, "fixture");
  assert.equal(p.nonce, nonce);
  assert.equal(p.uri, uri);
  assert.equal(p.algorithm, normalized);
  assert.equal(p.response, expected);
  if (qop) {
    assert.equal(p.qop, qop);
    assert.equal(p.nc, "00000001");
    assert.ok(p.cnonce);
  } else {
    assert.equal(p.qop, undefined);
    assert.equal(p.nc, undefined);
    if (normalized.endsWith("-SESS")) assert.ok(p.cnonce);
    else assert.equal(p.cnonce, undefined);
  }
  return p;
}

test("Digest policy is absent only when omitted; valid six canonical algorithms produce immutable copies", () => {
  assert.equal(digestChallengePolicy(credentials), undefined);
  for (const algorithm of algorithms)
    for (const retry of [true, false])
      for (const prototype of [Object.prototype, null]) {
        const policy = Object.assign(Object.create(prototype), {
          algorithm,
          retry,
        });
        const before = descriptors(policy);
        const result = digestChallengePolicy({
          ...credentials,
          challengePolicy: policy,
        });
        assert.deepEqual(result, { algorithm, retry });
        assert.equal(Object.isFrozen(result), true);
        assert.notEqual(result, policy);
        policy.retry = !retry;
        assert.equal(result.retry, retry);
        policy.retry = retry;
        assert.deepEqual(descriptors(policy), before);
      }
});

test("Digest policy exact schema rejects own undefined/null/arrays/missing/extra/type/coercion without secret errors", () => {
  const values = [
    undefined,
    null,
    [],
    "",
    false,
    0,
    {},
    { algorithm: "MD5" },
    { retry: true },
    { algorithm: "MD5", retry: "false" },
    { algorithm: "MD5", retry: 0 },
    { algorithm: "MD5", retry: null },
    { algorithm: "MD5", retry: undefined },
  ];
  for (const algorithm of [
    undefined,
    null,
    "",
    "md5",
    "MD5-SESS",
    "sha-256",
    "SHA-256-SESS",
    "SHA-512/256",
    "SHA-512",
    "none",
    "{{algorithm}}",
    false,
    [],
    {},
  ])
    values.push({ algorithm, retry: true });
  for (const value of [undefined, null, "", false, 0, secret])
    values.push({ algorithm: "MD5", retry: true, [marker]: value });
  for (const challengePolicy of values)
    assert.throws(
      () => digestChallengePolicy({ ...credentials, challengePolicy }),
      redacted,
    );
});

test("Digest direct policy descriptor preflight rejects accessors hidden/symbol/custom prototype without getters or toJSON", () => {
  for (const field of ["algorithm", "retry", marker, "toJSON"])
    for (const enumerable of [true, false]) {
      let read = 0;
      const policy = { algorithm: "MD5", retry: true };
      Object.defineProperty(policy, field, {
        get() {
          read++;
          throw Error(secret);
        },
        enumerable,
        configurable: true,
      });
      const before = descriptors(policy);
      assert.throws(
        () =>
          digestChallengePolicy({ ...credentials, challengePolicy: policy }),
        redacted,
      );
      assert.equal(read, 0);
      assert.deepEqual(descriptors(policy), before);
    }
  for (const field of ["algorithm", "retry", marker]) {
    const policy = { algorithm: "MD5", retry: true };
    Object.defineProperty(policy, field, { value: secret, enumerable: false });
    assert.throws(
      () => digestChallengePolicy({ ...credentials, challengePolicy: policy }),
      redacted,
    );
  }
  for (const symbol of [Symbol(marker), Symbol.toStringTag]) {
    const policy = { algorithm: "MD5", retry: true, [symbol]: secret };
    assert.throws(
      () => digestChallengePolicy({ ...credentials, challengePolicy: policy }),
      redacted,
    );
  }
  class Policy {
    constructor() {
      this.algorithm = "MD5";
      this.retry = true;
    }
  }
  for (const policy of [
    new Policy(),
    Object.assign(Object.create({ extra: true }), {
      algorithm: "MD5",
      retry: true,
    }),
    Object.create({ algorithm: "MD5", retry: true }),
  ])
    assert.throws(
      () => digestChallengePolicy({ ...credentials, challengePolicy: policy }),
      redacted,
    );
  let calls = 0;
  const policy = {
    algorithm: "MD5",
    retry: true,
    toJSON() {
      calls++;
      throw Error(secret);
    },
  };
  assert.throws(
    () => digestChallengePolicy({ ...credentials, challengePolicy: policy }),
    redacted,
  );
  assert.equal(calls, 0);
  const selector = { ...credentials };
  Object.defineProperty(selector, "challengePolicy", {
    get() {
      calls++;
      throw Error(secret);
    },
    enumerable: true,
  });
  assert.throws(() => digestChallengePolicy(selector), redacted);
  assert.equal(calls, 0);
  const inherited = Object.assign(
    Object.create({ challengePolicy: { algorithm: "MD5", retry: true } }),
    credentials,
  );
  assert.throws(() => digestChallengePolicy(inherited), redacted);
});

test("shared auth model rejects policy on every non-Digest type, even undefined", () => {
  for (const type of authTypes.filter((type) => type !== "digest"))
    for (const challengePolicy of [
      undefined,
      { algorithm: "MD5", retry: true },
    ])
      assert.throws(() => validateAuth({ type, challengePolicy }), redacted);
  assert.throws(
    () => validateAuth({ challengePolicy: { algorithm: "MD5", retry: false } }),
    redacted,
  );
  validateAuth(auth("SHA-512-256-sess"));
  validateAuth(credentials);
});

for (const algorithm of algorithms)
  test(`direct Digest policy ${algorithm} matches normalized challenge and independent auth/auth-int/session hashes`, () => {
    for (const qop of [null, "auth", "auth-int", "auth-int, auth"]) {
      const body = Buffer.from([0, 255, 13, 10, 42]),
        selected =
          qop?.includes("auth-int") && !qop.includes(",")
            ? "auth-int"
            : qop === null
              ? null
              : "auth";
      const challenge = offer(algorithm.toLowerCase(), qop);
      const authorization = digestAuthorization(
        challenge,
        auth(algorithm),
        "POST",
        "/entity?a=1",
        body,
        "fixed-cnonce",
      );
      verify(authorization, {
        algorithm,
        method: "POST",
        uri: "/entity?a=1",
        body,
        qop: selected,
      });
    }
  });

test("policy enforces first supported challenge, never scans later offers to satisfy an algorithm preference", () => {
  assert.throws(
    () =>
      digestAuthorization(
        [offer("SHA-256"), offer("MD5")],
        auth("MD5"),
        "GET",
        "/",
      ),
    redacted,
  );
  assert.throws(
    () =>
      digestAuthorization(
        [offer("MD5"), offer("SHA-256")],
        auth("SHA-256"),
        "GET",
        "/",
      ),
    redacted,
  );
  verify(
    digestAuthorization(
      [offer("SHA-999"), offer("MD5")],
      auth("MD5"),
      "GET",
      "/",
      "",
      "fixed",
    ),
    { algorithm: "MD5" },
  );
  verify(
    digestAuthorization(
      [offer("SHA-256", "unavailable"), offer("MD5")],
      auth("MD5"),
      "GET",
      "/",
      "",
      "fixed",
    ),
    { algorithm: "MD5" },
  );
  for (const malformed of [
    'Digest realm="fixture", nonce="FICTIONAL_CHALLENGE_PRIVATE_NONCE", nonce="duplicate", algorithm=SHA-256',
    'Digest nonce="FICTIONAL_CHALLENGE_PRIVATE_NONCE", algorithm=SHA-256',
    'Digest realm="unterminated',
  ])
    assert.throws(
      () =>
        digestAuthorization([malformed, offer("MD5")], auth("MD5"), "GET", "/"),
      redacted,
    );
  for (const challenge of [offer("SHA-999"), offer("SHA-256", "unavailable")])
    assert.throws(
      () => digestAuthorization(challenge, auth(), "GET", "/"),
      redacted,
    );
  for (const challenge of [undefined, null, "", 'Basic realm="fixture"'])
    assert.equal(digestAuthorization(challenge, auth(), "GET", "/"), null);
});

test("retry false returns no Digest authorization without parsing malformed or oversized challenge", () => {
  for (const challenge of [
    'Digest realm="unterminated',
    "\0FICTIONAL_CHALLENGE_PRIVATE_NONCE",
    "x".repeat(17000),
    { secret },
    [1],
  ])
    assert.equal(
      digestAuthorization(
        challenge,
        auth("MD5", false),
        "GET",
        "/",
        "",
        "fixed",
      ),
      null,
    );
  assert.throws(
    () =>
      digestAuthorization(
        'Digest realm="unterminated',
        {
          ...credentials,
          challengePolicy: { algorithm: "MD5", retry: "false" },
        },
        "GET",
        "/",
      ),
    redacted,
  );
});

test("legacy top-level algorithm and disableRetryRequest stay inert", () => {
  const legacy = {
    ...credentials,
    algorithm: "SHA-512-256",
    disableRetryRequest: true,
  };
  assert.equal(digestChallengePolicy(legacy), undefined);
  verify(digestAuthorization(offer("MD5"), legacy, "GET", "/", "", "fixed"), {
    algorithm: "MD5",
  });
});

async function origin(
  t,
  {
    algorithm = "SHA-256",
    qop = "auth-int",
    challenge,
    firstStatus = 401,
    finalStatus = 200,
    location,
    holdFinal = false,
    onAuthorized,
    rejectCredentials = false,
  } = {},
) {
  const requests = [],
    failures = [],
    nonces = new Map(),
    sockets = new Set(),
    closes = [];
  let sequence = 0,
    connections = 0;
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const record = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(record);
      if (!req.headers.authorization) {
        const nonce = "fresh-" + ++sequence;
        nonces.set(nonce, record);
        res.writeHead(firstStatus, {
          "WWW-Authenticate":
            typeof challenge === "function"
              ? challenge(nonce)
              : (challenge ?? offer(algorithm.toLowerCase(), qop, nonce)),
          "Set-Cookie": "digest-challenge=" + nonce + "; Path=/",
          Connection: "close",
          ...(location ? { Location: location } : {}),
        });
        return res.end("first response");
      }
      const parsed = parseAuthorization(req.headers.authorization),
        first = nonces.get(parsed.nonce);
      assert.ok(first, "each execution requires a fresh challenge");
      const selectedQop =
        qop?.includes("auth-int") && !qop.includes(",")
          ? "auth-int"
          : qop === null
            ? null
            : "auth";
      const expectedUser = req.url.startsWith("/bob") ? "bob" : "alice",
        password = expectedUser === "bob" ? "fictional-bob-password" : secret;
      const verification = () =>
        verify(req.headers.authorization, {
          algorithm,
          username: expectedUser,
          password,
          method: req.method,
          uri: req.url,
          body: record.body,
          qop: selectedQop,
          nonce: parsed.nonce,
        });
      if (rejectCredentials) assert.throws(verification);
      else verification();
      assert.deepEqual(record.body, first.body);
      assert.equal(req.headers["content-type"], first.headers["content-type"]);
      assert.equal(
        req.headers["content-length"],
        first.headers["content-length"],
      );
      record.first = first;
      record.digest = parsed;
      onAuthorized?.(record);
      if (holdFinal) return;
      res.writeHead(finalStatus, {
        "WWW-Authenticate": offer(algorithm, qop, "do-not-retry-again"),
        "Content-Type": "application/json",
        ...(location ? { Location: location } : {}),
      });
      res.end('{"ok":true}');
    } catch (error) {
      failures.push(error);
      if (!res.destroyed) {
        res.writeHead(500);
        res.end("fixture verification failed");
      }
    }
  });
  server.on("connection", (socket) => {
    connections++;
    sockets.add(socket);
    closes.push(
      new Promise((resolve) =>
        socket.once("close", () => {
          sockets.delete(socket);
          resolve();
        }),
      ),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    const stopped = new Promise((resolve) => server.close(resolve));
    for (const socket of sockets) socket.destroy();
    await Promise.all(closes);
    await stopped;
    assert.deepEqual(failures, []);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    get connections() {
      return connections;
    },
  };
}
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

for (const algorithm of algorithms)
  test(`HTTP ${algorithm} explicit matching policy replays exact prepared multipart and binary entity once`, async (t) => {
    const target = await origin(t, { algorithm });
    for (const entity of [
      { bodyType: "form-data", form: multipart },
      { bodyType: "raw", body: "raw\0中\r\n" },
    ]) {
      const count = target.requests.length;
      const response = await executeRequest({
        url: target.url + "/entity?x=1",
        method: "POST",
        ...entity,
        auth: auth(algorithm),
      });
      assert.equal(response.status, 200);
      assert.equal(target.requests.length - count, 2);
      assert.equal(target.requests[count].headers.authorization, undefined);
      assert.equal(target.requests[count + 1].digest.nc, "00000001");
    }
  });

test("invalid policy fails before any connection setup, including disabled but malformed policy and non-Digest use", async (t) => {
  const target = await origin(t);
  for (const invalid of [
    undefined,
    null,
    [],
    {},
    { algorithm: "MD5", retry: "false" },
    { algorithm: "MD5", retry: false, [marker]: secret },
  ])
    await assert.rejects(
      executeRequest({
        url: target.url,
        auth: { ...credentials, challengePolicy: invalid },
      }),
      redacted,
    );
  await assert.rejects(
    executeRequest({
      url: target.url,
      auth: {
        type: "basic",
        username: "alice",
        password: secret,
        challengePolicy: { algorithm: "MD5", retry: true },
      },
    }),
    redacted,
  );
  assert.equal(target.connections, 0);
  assert.deepEqual(target.requests, []);
});

test("HTTP retry false returns malformed first 401 unchanged; non-401 response also cannot trigger retry", async (t) => {
  for (const status of [401, 403, 200]) {
    const target = await origin(t, {
      firstStatus: status,
      challenge: 'Digest realm="unterminated',
    });
    const result = await executeRequest({
      url: target.url,
      auth: auth("MD5", false),
    });
    assert.equal(result.status, status);
    assert.equal(target.requests.length, 1);
    assert.equal(target.requests[0].headers.authorization, undefined);
  }
});

test("HTTP policy mismatch and malformed preferred offer send no credentials and cannot downgrade", async (t) => {
  for (const challenge of [
    [offer("SHA-256"), offer("MD5")],
    [
      'Digest realm="fixture", nonce="FICTIONAL_CHALLENGE_PRIVATE_NONCE", nonce="duplicate", algorithm=SHA-256',
      offer("MD5"),
    ],
  ]) {
    const target = await origin(t, { challenge });
    await assert.rejects(
      executeRequest({ url: target.url, auth: auth("MD5") }),
      redacted,
    );
    assert.equal(target.requests.length, 1);
    assert.equal(target.requests[0].headers.authorization, undefined);
  }
});

test("HTTP omitted policy preserves legacy retry despite ignored old top-level fields", async (t) => {
  const target = await origin(t, { algorithm: "MD5", qop: "auth" });
  const result = await executeRequest({
    url: target.url,
    auth: {
      ...credentials,
      algorithm: "SHA-512-256",
      disableRetryRequest: true,
    },
  });
  assert.equal(result.status, 200);
  assert.equal(target.requests.length, 2);
});

test("runtime snapshots policy before first IO and refreshes challenge cookies without reading later caller mutations", async (t) => {
  const target = await origin(t),
    definition = auth("SHA-256");
  let cookie = null;
  const result = await executeRequest(
    {
      url: target.url,
      method: "POST",
      bodyType: "form-data",
      form: multipart,
      auth: definition,
    },
    undefined,
    {
      cookieSession: {
        header: async () => cookie,
        capture: async (_url, values) => {
          if (values) {
            cookie = values[0].split(";")[0];
            definition.challengePolicy.algorithm = "MD5";
            definition.challengePolicy.retry = false;
            definition.challengePolicy[marker] = secret;
          }
        },
      },
    },
  );
  assert.equal(result.status, 200);
  assert.equal(target.requests.length, 2);
  assert.equal(
    target.requests[1].headers.cookie,
    "digest-challenge=" + target.requests[1].digest.nonce,
  );
});

test("concurrent Digest identities and repeated executions use fresh challenge nonces/cnonces without persisted state", async (t) => {
  const target = await origin(t, { algorithm: "SHA-256-sess" }),
    alice = auth("SHA-256-sess"),
    bob = {
      ...auth("SHA-256-sess"),
      username: "bob",
      password: "fictional-bob-password",
    };
  const before = structuredClone([alice, bob]);
  for (let i = 0; i < 2; i++) {
    const results = await Promise.all([
      executeRequest({ url: target.url + "/alice", auth: alice }),
      executeRequest({ url: target.url + "/bob", auth: bob }),
    ]);
    assert.ok(results.every((result) => result.status === 200));
  }
  const authenticated = target.requests.filter((r) => r.digest);
  assert.equal(authenticated.length, 4);
  assert.equal(new Set(authenticated.map((r) => r.digest.nonce)).size, 4);
  assert.equal(new Set(authenticated.map((r) => r.digest.cnonce)).size, 4);
  assert.ok(authenticated.every((r) => r.digest.nc === "00000001"));
  assert.deepEqual([alice, bob], before);
});

test("authenticated 401 is returned without a third request even with stale-looking new challenge", async (t) => {
  const target = await origin(t, { finalStatus: 401 });
  const result = await executeRequest({ url: target.url, auth: auth() });
  assert.equal(result.status, 401);
  assert.equal(target.requests.length, 2);
});

for (const mode of ["abort", "deadline"])
  test(`Digest ${mode} after first challenge prevents replay under original deadline`, async (t) => {
    const target = await origin(t),
      controller = new AbortController();
    await assert.rejects(
      executeRequest(
        { url: target.url, auth: auth(), timeout: 100 },
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
    assert.equal(target.requests.length, 1);
  });

test("abort while authenticated response is outstanding cannot issue a third request", async (t) => {
  let reached;
  const authorized = new Promise((resolve) => {
    reached = resolve;
  });
  const target = await origin(t, {
      holdFinal: true,
      onAuthorized: () => reached(),
    }),
    controller = new AbortController();
  const pending = executeRequest(
    { url: target.url, auth: auth(), timeout: 5000 },
    controller.signal,
  );
  const rejected = assert.rejects(pending, /abort|取消/i);
  await authorized;
  controller.abort();
  await rejected;
  assert.equal(target.requests.length, 2);
});

test("narrow Digest transport returns 3xx without follow or credential forwarding before or after authentication", async (t) => {
  const destination = await origin(t, { firstStatus: 200 });
  for (const afterAuth of [false, true]) {
    const target = await origin(t, {
      firstStatus: afterAuth ? 401 : 302,
      finalStatus: 302,
      location: destination.url + "/must-not-follow",
    });
    const result = await executeRequest({ url: target.url, auth: auth() });
    assert.equal(result.status, 302);
    assert.equal(target.requests.length, afterAuth ? 2 : 1);
    assert.equal(destination.requests.length, 0);
    assert.equal(destination.connections, 0);
  }
});

test("direct credentials type association rejects foreign/accessor/inherited type without reading getters; missing type remains supported", () => {
  const policy = { algorithm: "MD5", retry: true };
  assert.deepEqual(
    digestChallengePolicy({
      username: "alice",
      password: secret,
      challengePolicy: policy,
    }),
    policy,
  );
  assert.throws(
    () => digestChallengePolicy({ type: "basic", challengePolicy: policy }),
    redacted,
  );
  let reads = 0;
  const value = { challengePolicy: policy };
  Object.defineProperty(value, "type", {
    get() {
      reads++;
      throw Error(secret);
    },
    enumerable: true,
  });
  assert.throws(() => digestChallengePolicy(value), redacted);
  assert.equal(reads, 0);
  assert.throws(
    () =>
      digestChallengePolicy(
        Object.assign(Object.create({ type: "digest" }), {
          challengePolicy: policy,
        }),
      ),
    redacted,
  );
  const legacy = {};
  for (const key of ["type", "algorithm", "disableRetryRequest"])
    Object.defineProperty(legacy, key, {
      get() {
        reads++;
        throw Error(secret);
      },
      enumerable: true,
    });
  assert.equal(digestChallengePolicy(legacy), undefined);
  assert.equal(reads, 0);
});

test("normalization preserves policy selector safety and runtime rejects malformed inner descriptors before connections", async (t) => {
  const target = await origin(t);
  let reads = 0;
  const getter = { ...credentials };
  Object.defineProperty(getter, "challengePolicy", {
    get() {
      reads++;
      throw Error(secret);
    },
    enumerable: true,
  });
  const hidden = { ...credentials };
  Object.defineProperty(hidden, "challengePolicy", {
    value: { algorithm: "MD5", retry: true },
    enumerable: false,
  });
  const inherited = Object.assign(
    Object.create({ challengePolicy: { algorithm: "MD5", retry: true } }),
    credentials,
  );
  for (const candidate of [getter, hidden, inherited]) {
    assert.throws(
      () => normalizeRequest({ url: target.url, auth: candidate }),
      redacted,
    );
    await assert.rejects(
      executeRequest({ url: target.url, auth: candidate }),
      redacted,
    );
  }
  const accessor = { algorithm: "MD5" };
  Object.defineProperty(accessor, "retry", {
    get() {
      reads++;
      throw Error(secret);
    },
    enumerable: true,
  });
  for (const challengePolicy of [
    accessor,
    { algorithm: "MD5", retry: true, [marker]: secret },
    { algorithm: "MD5", retry: true, [Symbol.toStringTag]: secret },
  ])
    await assert.rejects(
      executeRequest({
        url: target.url,
        auth: { ...credentials, challengePolicy },
      }),
      redacted,
    );
  assert.equal(reads, 0);
  assert.equal(target.connections, 0);
  assert.deepEqual(target.requests, []);
});

test("HTTP unsupported leading offer preserves supported selection and empty/no-Digest challenge returns first response", async (t) => {
  const target = await origin(t, {
    algorithm: "MD5",
    qop: "auth",
    challenge: (nonce) => [
      offer("SHA-999", "auth", nonce),
      offer("MD5", "auth", nonce),
    ],
  });
  assert.equal(
    (await executeRequest({ url: target.url, auth: auth("MD5") })).status,
    200,
  );
  assert.equal(target.requests.length, 2);
  for (const challenge of ["", 'Basic realm="fixture"']) {
    const noDigest = await origin(t, { challenge });
    const result = await executeRequest({ url: noDigest.url, auth: auth() });
    assert.equal(result.status, 401);
    assert.equal(noDigest.requests.length, 1);
    assert.equal(noDigest.requests[0].headers.authorization, undefined);
  }
});

test("independently rejected credentials receive one authenticated 401, never a replay loop", async (t) => {
  const target = await origin(t, { rejectCredentials: true, finalStatus: 401 });
  const result = await executeRequest({
    url: target.url,
    auth: { ...auth(), password: "wrong-fictional-password" },
  });
  assert.equal(result.status, 401);
  assert.equal(target.requests.length, 2);
});

test("retry true still processes only 401, never a valid Digest challenge on 403", async (t) => {
  const target = await origin(t, { firstStatus: 403 });
  const response = await executeRequest({
    url: target.url,
    auth: auth("SHA-256", true),
  });
  assert.equal(response.status, 403);
  assert.equal(target.requests.length, 1);
  assert.equal(target.requests[0].headers.authorization, undefined);
});

test("raw plan policy cannot become valid through variable interpolation", async () => {
  const plan = {
    steps: [
      {
        id: "raw-policy",
        request: {
          url: "http://127.0.0.1:1/must-not-connect",
          auth: auth("{{selected}}"),
        },
      },
    ],
  };
  const before = structuredClone(plan);
  let executions = 0;
  await assert.rejects(
    runPlan(plan, { selected: "SHA-256" }, async () => {
      executions++;
    }),
    (error) => {
      redacted(error);
      assert.match(error.message, /challengePolicy/);
      return true;
    },
  );
  assert.equal(executions, 0);
  assert.deepEqual(plan, before);
});

test("whole raw plan policy preflight precedes scripts that try to repair it", async () => {
  const plan = {
    steps: [
      {
        id: "earlier-effects",
        request: {
          url: "http://127.0.0.1:1/must-not-connect",
          beforeScript:
            'pm.environment.set("mustNotRun", "yes"); throw Error("SCRIPT_MUST_NOT_RUN");',
        },
      },
      {
        id: "repair-attempt",
        request: {
          url: "http://127.0.0.1:1/must-not-connect",
          auth: auth("{{selected}}"),
          beforeScript:
            'request.auth.challengePolicy = {algorithm: "SHA-256", retry: true}; pm.environment.set("mustNotRun", "yes");',
        },
      },
    ],
  };
  const before = structuredClone(plan);
  const effects = { execute: 0, prepare: 0, scope: 0, step: 0 };
  await assert.rejects(
    runPlan(
      plan,
      { selected: "SHA-256" },
      async () => {
        effects.execute++;
      },
      {
        prepareRequest: async (request) => {
          effects.prepare++;
          return request;
        },
        onScopeChanges: async () => {
          effects.scope++;
        },
        onStep: async () => {
          effects.step++;
        },
      },
    ),
    (error) => {
      redacted(error);
      assert.match(error.message, /challengePolicy/);
      assert.doesNotMatch(error.message, /SCRIPT_MUST_NOT_RUN/);
      return true;
    },
  );
  assert.deepEqual(effects, { execute: 0, prepare: 0, scope: 0, step: 0 });
  assert.deepEqual(plan, before);
});
