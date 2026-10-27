import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import http2 from "node:http2";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store, executeRequest } from "../src/runtime.mjs";
import {
  importDocument,
  normalizeRequest,
  snapshotPlan,
  restoreProject,
  runPlan,
} from "../src/core.mjs";
import { recordPlanRun } from "../src/plan-evidence.mjs";
import { validateSharedAuthSettings } from "../src/shared-auth.mjs";
import * as signing from "../src/aws-signature.mjs";

// Independent verifier: no production signer or Smithy imports. Its canonical
// calculation is checked against AWS's published, fictional S3 example first.
const uri = (value) =>
    encodeURIComponent(value).replace(
      /[!'()*]/g,
      (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
    ),
  hash = (value) => createHash("sha256").update(value).digest("hex"),
  mac = (key, value) => createHmac("sha256", key).update(value).digest(),
  identities = new Map([
    [
      "fixture-A",
      { secret: "FICTIONAL_SECRET_A", token: "FICTIONAL_TOKEN_A+/= 中文" },
    ],
    ["fixture-B", { secret: "FICTIONAL_SECRET_B", token: "" }],
  ]);
function verify(
  { method, rawURL, headers, body = Buffer.alloc(0) },
  keys = identities,
  now = Date.now(),
) {
  try {
    const url = new URL(rawURL, "http://local"),
      q = url.searchParams;
    for (const key of [
      "X-Amz-Algorithm",
      "X-Amz-Credential",
      "X-Amz-Date",
      "X-Amz-Expires",
      "X-Amz-SignedHeaders",
      "X-Amz-Signature",
    ])
      if (q.getAll(key).length !== 1)
        return { valid: false, reason: "query-only authentication required" };
    const [identity, date, region, service, terminator] = q
        .get("X-Amz-Credential")
        .split("/"),
      credentials = keys.get(identity),
      stamp = q.get("X-Amz-Date"),
      iso = stamp.replace(
        /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
        "$1-$2-$3T$4:$5:$6Z",
      ),
      timestamp = Date.parse(iso),
      expiry = Number(q.get("X-Amz-Expires"));
    if (
      !credentials ||
      q.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256" ||
      service !== "s3" ||
      terminator !== "aws4_request" ||
      !/^[a-z0-9-]+$/.test(region) ||
      date !== stamp.slice(0, 8)
    )
      return { valid: false, reason: "credentials/scope" };
    if (
      headers.authorization ||
      !["GET", "HEAD"].includes(method) ||
      body.length
    )
      return { valid: false, reason: "ambiguous authentication/body" };
    if (
      !Number.isFinite(timestamp) ||
      !Number.isInteger(expiry) ||
      expiry < 1 ||
      expiry > 604800 ||
      now < timestamp ||
      now >= timestamp + expiry * 1000
    )
      return { valid: false, reason: "expired" };
    if ((q.get("X-Amz-Security-Token") || "") !== credentials.token)
      return { valid: false, reason: "session token" };
    const names = q.get("X-Amz-SignedHeaders").split(";");
    if (
      !names.includes("host") ||
      new Set(names).size !== names.length ||
      [...names].sort().join(";") !== names.join(";")
    )
      return { valid: false, reason: "signed headers" };
    const actual = { ...headers, host: headers.host || headers[":authority"] };
    if (names.some((name) => actual[name] === undefined))
      return { valid: false, reason: "missing signed header" };
    const canonicalHeaders = names
        .map(
          (name) =>
            name +
            ":" +
            String(actual[name]).trim().replace(/\s+/g, " ") +
            "\n",
        )
        .join(""),
      pairs = [...q]
        .filter(([key]) => key !== "X-Amz-Signature")
        .map(([key, value]) => [uri(key), uri(value)]);
    pairs.sort((a, b) =>
      a[0] === b[0]
        ? a[1] < b[1]
          ? -1
          : a[1] > b[1]
            ? 1
            : 0
        : a[0] < b[0]
          ? -1
          : 1,
    );
    const canonicalPath = url.pathname
      .split("/")
      .map((part) => uri(decodeURIComponent(part)))
      .join("/");
    const canonical = [
        method,
        canonicalPath,
        pairs.map(([key, value]) => key + "=" + value).join("&"),
        canonicalHeaders,
        names.join(";"),
        "UNSIGNED-PAYLOAD",
      ].join("\n"),
      scope = [date, region, service, "aws4_request"].join("/"),
      toSign = ["AWS4-HMAC-SHA256", stamp, scope, hash(canonical)].join("\n"),
      key = mac(
        mac(mac(mac("AWS4" + credentials.secret, date), region), service),
        "aws4_request",
      ),
      expected = mac(key, toSign),
      received = Buffer.from(q.get("X-Amz-Signature"), "hex");
    return {
      valid:
        expected.length === received.length &&
        timingSafeEqual(expected, received),
      identity,
      reason: "signature",
    };
  } catch {
    return { valid: false, reason: "malformed" };
  }
}
const auth = (identity = "fixture-A", extra = {}) => ({
  type: "aws",
  accessKey: identity,
  secretKey: identities.get(identity).secret,
  sessionToken: identities.get(identity).token,
  region: "us-east-1",
  service: "s3",
  addAuthDataToQuery: true,
  ...extra,
});
function postman(url, configuration = auth()) {
  const { type: _type, ...fields } = configuration;
  return {
    info: { name: "independent query auth" },
    item: [
      {
        name: "Query protected object",
        request: {
          method: "GET",
          url,
          auth: {
            type: "awsv4",
            awsv4: Object.entries(fields).map(([key, value]) => ({
              key,
              value,
            })),
          },
        },
      },
    ],
  };
}
async function endpoint(t, version = "1.1") {
  const captured = [],
    sessions = new Set();
  let clock = () => Date.now();
  const server = version === "2" ? http2.createServer() : http.createServer();
  server.on("session", (session) => {
    sessions.add(session);
    session.on("error", () => {});
    session.on("close", () => sessions.delete(session));
  });
  server.on("request", async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = {
        method: request.method,
        rawURL: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks),
      },
      url = new URL(request.url, "http://local");
    const result =
      url.pathname === "/next"
        ? {
            valid: identities.has(url.searchParams.get("identity")),
            identity: url.searchParams.get("identity"),
          }
        : verify(input, identities, clock());
    captured.push({ ...input, ...result });
    response.writeHead(result.valid ? 200 : 403, {
      "content-type": "application/json",
    });
    response.end(
      JSON.stringify({
        identity: result.identity,
        error: result.valid ? undefined : result.reason,
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const session of sessions) session.destroy();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    url: "http://127.0.0.1:" + server.address().port,
    captured,
    clock: (value) => {
      clock = value;
    },
  };
}

test("independent verifier and production signer match the published AWS S3 query signature", async () => {
  const url =
      "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    keys = new Map([
      [
        "AKIAIOSFODNN7EXAMPLE",
        { secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", token: "" },
      ],
    ]),
    input = {
      method: "GET",
      rawURL: url,
      headers: { host: "examplebucket.s3.amazonaws.com" },
    },
    now = Date.parse("2013-05-24T12:00:00Z");
  assert.equal(verify(input, keys, now).valid, true);
  assert.equal(
    verify(
      { ...input, rawURL: url.replace("test.txt", "other.txt") },
      keys,
      now,
    ).valid,
    false,
  );
  const result = await signing.awsSignatureRequest(
    "https://examplebucket.s3.amazonaws.com/test.txt",
    "GET",
    {},
    undefined,
    {
      type: "aws",
      accessKey: "AKIAIOSFODNN7EXAMPLE",
      secretKey: keys.values().next().value.secret,
      service: "s3",
      region: "us-east-1",
      addAuthDataToQuery: true,
      signingDate: "2013-05-24T00:00:00Z",
    },
  );
  assert.equal(
    new URL(result.url).searchParams.get("X-Amz-Signature"),
    "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
  );
  assert.deepEqual(Object.keys(result.headers), ["host"]);
  assert.equal(
    verify(
      { method: "GET", rawURL: result.url, headers: result.headers },
      keys,
      now,
    ).valid,
    true,
  );
});

test("Postman query auth reaches a real query-only HTTP verifier instead of silently falling back to headers", async (t) => {
  const server = await endpoint(t),
    source = postman(
      server.url + "/object?tag=z&tag=a&empty=&space=a+b",
      auth("fixture-B"),
    ),
    sourceBefore = structuredClone(source),
    [request] = importDocument(source);
  const response = await executeRequest(request);
  assert.equal(
    response.status,
    200,
    "import must preserve Query authentication: " + response.body,
  );
  assert.equal(request.auth.addAuthDataToQuery, true);
  assert.deepEqual(source, sourceBefore);
  assert.equal(request.url.includes("X-Amz-Signature"), false);
  const wire = server.captured[0],
    url = new URL(wire.rawURL, server.url);
  assert.equal(wire.headers.authorization, undefined);
  assert.deepEqual(url.searchParams.getAll("tag"), ["z", "a"]);
  assert.equal(url.searchParams.get("X-Amz-Expires"), "86400");
  assert.equal(url.searchParams.has("x-amz-content-sha256"), false);
  assert.equal(
    url.searchParams.get("X-Amz-Security-Token") || "",
    identities.get("fixture-B").token,
  );
  assert(wire.rawURL.includes("space=a%20b"));
  assert.equal(response.request.url, server.url + wire.rawURL);
});

test("S3 GET/HEAD query signatures verify over real HTTP1 and HTTP2 with duplicate query, Unicode, escaped paths and clean headers", async (t) => {
  for (const version of ["1.1", "2"]) {
    const server = await endpoint(t, version);
    for (const method of ["GET", "HEAD"]) {
      const request = {
          url:
            server.url +
            "/unicode-%E4%B8%AD/key%2Fpart%252F?tag=z&tag=a&empty=&special=%21%27%28%29%2A&X-Amz-Expires=60",
          method,
          httpVersion: version,
          auth: auth(),
          headers: [
            { key: "Authorization", value: "STALE-AUTH-MUST-NOT-LEAVE" },
            { key: "X-Amz-Date", value: "STALE-DATE" },
            { key: "X-Amz-Security-Token", value: "STALE-TOKEN" },
            { key: "X-Amz-Content-Sha256", value: "STALE-HASH" },
            { key: "X-Amz-Meta-Repeat", value: " one   two " },
            { key: "x-amz-meta-repeat", value: "three" },
            { key: "X-Fixture", value: "wire" },
          ],
        },
        before = structuredClone(request);
      const response = await executeRequest(request),
        wire = server.captured.at(-1),
        url = new URL(wire.rawURL, server.url);
      assert.equal(response.status, 200, response.body);
      assert.equal(wire.valid, true);
      assert.equal(wire.method, method);
      assert.equal(wire.body.length, 0);
      assert.equal(url.pathname, "/unicode-%E4%B8%AD/key%2Fpart%252F");
      assert.deepEqual(url.searchParams.getAll("tag"), ["z", "a"]);
      assert.equal(url.searchParams.get("X-Amz-Expires"), "60");
      assert.equal(url.searchParams.get("special"), "!'()*");
      assert(wire.rawURL.includes("special=%21%27%28%29%2A"));
      assert.equal(wire.headers["x-amz-meta-repeat"], "one two,three");
      assert.equal(url.searchParams.has("x-amz-meta-repeat"), false);
      assert(
        url.searchParams
          .get("X-Amz-SignedHeaders")
          .includes("x-amz-meta-repeat"),
      );
      assert.equal(JSON.stringify(response.request).includes("STALE-"), false);
      assert.equal(
        JSON.stringify(response.request).includes(
          identities.get("fixture-A").secret,
        ),
        false,
      );
      assert.deepEqual(request, before);
    }
  }
});

test("query-mode unsupported methods/services/body, ambiguous controls and header/query collisions reject before any network", async (t) => {
  const server = await endpoint(t),
    base = { url: server.url + "/object", auth: auth() };
  const bad = [
    { auth: auth("fixture-A", { addAuthDataToQuery: "true" }) },
    { auth: auth("fixture-A", { addAuthDataToQuery: 1 }) },
    { auth: auth("fixture-A", { addAuthDataToQuery: null }) },
    { auth: auth("fixture-A", { service: "execute-api" }) },
    { auth: auth("fixture-A", { accessKey: "" }) },
    { auth: auth("fixture-A", { secretKey: "" }) },
    { auth: auth("fixture-A", { sessionToken: 12 }) },
    { method: "POST" },
    { method: "PUT" },
    { bodyType: "raw", body: "not-empty" },
    { bodyType: "json", body: "" },
    { bodyType: "binary", body: "AA==" },
    { bodyType: "form-data", form: [] },
    { headers: [{ key: "Content-Length", value: "1" }] },
    { headers: [{ key: "Transfer-Encoding", value: "chunked" }] },
    { headers: [{ key: "Host", value: "other.invalid" }] },
    { url: server.url + "/object?X-Amz-Expires=0" },
    { url: server.url + "/object?X-Amz-Expires=604801" },
    { url: server.url + "/object?X-Amz-Expires=1.5" },
    { url: server.url + "/object?X-Amz-Expires=1&X-Amz-Expires=2" },
    { url: server.url + "/object?X-Amz-Expires=1&x-amz-expires=1" },
    { url: server.url + "/object?X-Amz-Signature=old" },
    { url: server.url + "/object?X-Amz-Security-Token=old" },
    { url: server.url + "/object?X-Amz-Region-Set=*" },
    { url: server.url + "/object?x=%FF" },
    { url: server.url + "/object?x=%" },
    { url: server.url + "/object?__proto__=bad" },
    { url: server.url + "/object?%5F%5Fproto%5F%5F=bad" },
    { url: server.url + "/a/../object" },
    { url: server.url + "/a/%2E%2E/object" },
    { url: server.url + "/a/.%2E/object" },
    { url: server.url + "/a\\object" },
    { url: server.url + "/a%2fobject" },
    { url: server.url + "/a+object" },
    { url: server.url + "/a!object" },
    { url: server.url + "/%41" },
    { url: server.url + "/%7E" },
    { url: server.url + "/a%2Eb" },
    { url: server.url + "/object?value=\ud800" },
    {
      url: server.url + "/object?x-amz-meta-test=query",
      headers: [{ key: "X-Amz-Meta-Test", value: "header" }],
    },
    {
      url: server.url + "/object?X-AMZ-META-TEST=query",
      headers: [{ key: "x-amz-meta-test", value: "header" }],
    },
    { headers: [{ key: "X-Amz-Credential", value: "old" }] },
  ];
  for (const changes of bad)
    await assert.rejects(executeRequest({ ...base, ...changes }));
  assert.equal(server.captured.length, 0);
  const signingDate = "2026-01-01T00:00:00Z";
  server.clock(() => Date.parse(signingDate) + 500);
  for (const expires of ["1", "604800"])
    assert.equal(
      (
        await executeRequest({
          ...base,
          auth: auth("fixture-A", { signingDate }),
          url: base.url + "?X-Amz-Expires=" + expires,
        })
      ).status,
      200,
    );
  const [request] = importDocument(
    postman(base.url, auth("fixture-A", { addAuthDataToQuery: false })),
  );
  assert.equal(request.auth.addAuthDataToQuery, false);
  const duplicate = postman(base.url);
  duplicate.item[0].request.auth.awsv4.push({
    key: "addAuthDataToQuery",
    value: false,
  });
  assert.throws(() => importDocument(duplicate), /重复/);
  for (const value of ["true", "false", 0, 1, null]) {
    assert.throws(
      () =>
        importDocument(
          postman(base.url, auth("fixture-A", { addAuthDataToQuery: value })),
        ),
      /布尔/,
    );
    assert.throws(
      () =>
        normalizeRequest({
          ...base,
          auth: auth("fixture-A", { addAuthDataToQuery: value }),
        }),
      /布尔/,
    );
    assert.throws(
      () =>
        validateSharedAuthSettings({
          globalAuth: auth("fixture-A", { addAuthDataToQuery: value }),
        }),
      /布尔/,
    );
  }
});

test("real verifier rejects wrong signatures, changed query/token and expiration without silent retries", async (t) => {
  const server = await endpoint(t),
    request = {
      url: server.url + "/object?tag=first&tag=second&X-Amz-Expires=10",
      auth: auth(),
    };
  const correct = await executeRequest(request);
  assert.equal(correct.status, 200);
  const signed = new URL(correct.request.url),
    stamp = signed.searchParams.get("X-Amz-Date"),
    timestamp = Date.parse(
      stamp.replace(
        /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
        "$1-$2-$3T$4:$5:$6Z",
      ),
    );
  for (const change of [
    (url) => url.searchParams.set("tag", "tampered"),
    (url) => url.searchParams.set("X-Amz-Security-Token", "wrong"),
    (url) => url.searchParams.set("X-Amz-Signature", "0".repeat(64)),
  ]) {
    const altered = new URL(signed);
    change(altered);
    assert.equal(
      (
        await executeRequest({
          url: altered.href,
          headers: Object.entries(correct.request.headers).map(
            ([key, value]) => ({ key, value }),
          ),
        })
      ).status,
      403,
    );
  }
  const before = server.captured.length;
  assert.equal(
    (
      await executeRequest({
        ...request,
        auth: auth("fixture-A", { secretKey: "wrong-secret" }),
      })
    ).status,
    403,
  );
  assert.equal(server.captured.length, before + 1);
  server.clock(() => timestamp + 10000);
  assert.equal(
    (
      await executeRequest({
        url: signed.href,
        headers: Object.entries(correct.request.headers).map(
          ([key, value]) => ({ key, value }),
        ),
      })
    ).status,
    403,
  );
  assert.equal(server.captured.at(-1).reason, "expired");
});

test("query URLs are freshly generated per execution while legacy Header mode retains its Date and signature behavior", async (t) => {
  const initial = Date.parse("2026-01-01T00:00:00Z");
  t.mock.timers.enable({ apis: ["Date"], now: initial });
  const server = await endpoint(t),
    request = { url: server.url + "/object", auth: auth() },
    before = structuredClone(request);
  const first = await executeRequest(request);
  t.mock.timers.setTime(initial + 1000);
  const second = await executeRequest(request);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.notEqual(
    new URL(first.request.url).searchParams.get("X-Amz-Date"),
    new URL(second.request.url).searchParams.get("X-Amz-Date"),
  );
  assert.notEqual(
    new URL(first.request.url).searchParams.get("X-Amz-Signature"),
    new URL(second.request.url).searchParams.get("X-Amz-Signature"),
  );
  assert.deepEqual(request, before);
  const date = "Wed, 01 Jan 2020 00:00:00 GMT";
  for (const addAuthDataToQuery of [undefined, false]) {
    await executeRequest({
      url: server.url + "/header",
      method: "POST",
      bodyType: "raw",
      body: "legacy payload",
      headers: [{ key: "Date", value: date }],
      auth: auth("fixture-B", { addAuthDataToQuery }),
    });
    const wire = server.captured.at(-1);
    assert.equal(wire.headers.date, date);
    assert.match(wire.headers.authorization, /^AWS4-HMAC-SHA256 /);
    assert.equal(wire.headers["x-amz-content-sha256"], hash(wire.body));
    assert.equal(
      new URL(wire.rawURL, server.url).searchParams.has("X-Amz-Signature"),
      false,
    );
  }
});

test("Postman query auth survives frozen plans, real Store backup/restart and concurrent project execution without mutating definitions", async (t) => {
  const server = await endpoint(t),
    root = await mkdtemp(path.join(tmpdir(), "aws-query-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root),
    projects = [];
  for (const identity of identities.keys()) {
    const p = await store.create(identity),
      [request] = importDocument(
        postman(server.url + "/object?tag=b&tag=a", auth(identity)),
      );
    request.extract = [{ name: "signed_identity", path: "$.identity" }];
    request.assertions = [{ target: "status", op: "eq", value: 200 }];
    p.requests = [request];
    p.plans = [
      snapshotPlan({
        id: "query-plan",
        steps: [
          { request },
          {
            request: {
              name: "identity-dependent next request",
              url: server.url + "/next?identity={{signed_identity}}",
              assertions: [{ target: "status", op: "eq", value: 200 }],
            },
          },
        ],
      }),
    ];
    await store.save(p);
    projects.push(p);
  }
  const execute = async (p, activeStore = store) => {
    const definition = structuredClone(p.plans[0]);
    const run = await runPlan(p.plans[0], {}, executeRequest);
    assert.equal(run.status, "passed", JSON.stringify(run.results));
    assert.deepEqual(p.plans[0], definition);
    const saved = await recordPlanRun(activeStore, p.id, run, "query-fixture");
    assert.equal(saved.recordSaved, true);
    const response = run.results[0].response;
    assert.equal(JSON.parse(response.body).identity, p.name);
    assert(response.request.url.includes("X-Amz-Signature="));
    assert.equal(response.request.headers.authorization, undefined);
    assert.equal(
      JSON.stringify(response.request).includes(identities.get(p.name).secret),
      false,
    );
    return run;
  };
  await Promise.all(projects.map((p) => execute(p)));
  for (const original of projects) {
    const p = await store.get(original.id);
    // A live edit must not refresh an existing frozen plan's identity or URL.
    p.requests[0].auth = auth(
      p.name === "fixture-A" ? "fixture-B" : "fixture-A",
    );
    p.requests[0].url = "http://127.0.0.1:1/must-not-send";
    await store.save(p);
    const freshStore = new Store(root),
      reloaded = await freshStore.get(p.id);
    await execute(reloaded, freshStore);
    const backup = JSON.parse(JSON.stringify(await freshStore.get(p.id))),
      restored = restoreProject(backup);
    const originalPlan = JSON.parse(JSON.stringify(restored.plans[0]));
    await freshStore.save(restored);
    const afterRestart = await new Store(root).get(p.id);
    await execute(afterRestart, new Store(root));
    assert.deepEqual(afterRestart.plans[0], originalPlan);
    assert.equal(
      JSON.stringify(afterRestart.plans).includes("X-Amz-Signature"),
      false,
    );
    assert(
      afterRestart.runs.some((run) =>
        run.results[0].response.request.url.includes("X-Amz-Signature="),
      ),
    );
    const invalid = await freshStore.get(p.id);
    invalid.requests[0].auth.addAuthDataToQuery = "true";
    await assert.rejects(freshStore.save(invalid), /布尔/);
    assert.notEqual(
      (await new Store(root).get(p.id)).requests[0].auth.addAuthDataToQuery,
      "true",
    );
  }
  // Saving a completed operation may fail, but evidence handling must not send it again.
  const p = await store.get(projects[0].id),
    run = await runPlan(p.plans[0], {}, executeRequest),
    beforeSave = server.captured.length;
  const failedSave = await recordPlanRun(
    {
      append: async () => {
        throw Error("fixture storage fault");
      },
    },
    p.id,
    run,
    "query-fixture",
  );
  assert.equal(failedSave.status, "passed");
  assert.equal(failedSave.recordSaved, false);
  assert.equal(server.captured.length, beforeSave);
});

test("native S3 Query import preserves inherited mode through HTTP frozen execution, backup and restart without crossing identities", async (t) => {
  const { createApp } = await import("../src/server.mjs"),
    { importIntoProject } = await import("../src/core.mjs"),
    { modernApipostFixture } = await import("./fixtures/apipost-modern.mjs");
  const upstream = await endpoint(t),
    root = await mkdtemp(path.join(tmpdir(), "native-s3-query-"));
  let app = await createApp({ root, port: 0 });
  const close = async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });
  const headers = () => ({
    "x-local-token": app.token,
    "content-type": "application/json",
  });
  const projects = [];
  for (const identity of identities.keys()) {
    const source = modernApipostFixture(),
      p = await app.store.create(identity);
    source.project_id = "native-source-" + identity;
    source.global.envs[0].server_list[0].uri = upstream.url;
    const { type: _type, ...nativeAuth } = auth(identity);
    source.global.global_param.auth = { type: "awsv4", awsv4: nativeAuth };
    source.apis[1].url = "/object%2Fkey?tag=two&tag=one&X-Amz-Expires=60";
    source.apis[1].request.query = { parameter: [] };
    const before = structuredClone(source);
    importIntoProject(p, source);
    assert.deepEqual(source, before);
    assert.equal(p.requests[0].auth.addAuthDataToQuery, true);
    assert.equal(p.requests[0].auth.accessKey, identity);
    p.plans = [
      snapshotPlan({
        id: "native-query",
        environmentId: p.environments.find(
          (env) => env.serverUrls?.[p.requests[0].serviceId],
        ).id,
        steps: [{ request: p.requests[0] }],
      }),
    ];
    await app.store.save(p);
    projects.push({ id: p.id, identity, source });
  }
  const execute = async ({ id, identity }) => {
    const before = await app.store.get(id);
    const response = await fetch(app.url + "/api/projects/" + id + "/run", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ planId: "native-query" }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.equal(result.status, "passed", JSON.stringify(result.results));
    assert.equal(result.recordSaved, true);
    assert.equal(
      JSON.parse(result.results[0].response.body).identity,
      identity,
    );
    assert.equal(result.results[0].request.auth.addAuthDataToQuery, true);
    const after = await app.store.get(id);
    assert.deepEqual(after.requests, before.requests);
    assert.deepEqual(after.plans, before.plans);
    assert.equal(
      after.plans[0].steps[0].request.url.includes("X-Amz-Signature"),
      false,
    );
    assert(
      after.runs.some((run) => run.id === result.id && run.status === "passed"),
    );
    return result;
  };
  await Promise.all(projects.map(execute));
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );
  const configured = await fetch(app.url + "/api/mcp/config", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      enabled: true,
      projects: projects.map((p) => p.id),
      write: true,
      execute: true,
      remember: false,
    }),
  });
  assert.equal(configured.status, 200);
  const policy = await configured.json(),
    client = new Client({ name: "native-s3-query", version: "1" });
  t.after(() => client.close().catch(() => {}));
  await client.connect(
    new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + policy.token } },
    }),
  );
  for (const item of projects) {
    const p = await app.store.get(item.id);
    const response = await client.callTool({
      name: "localapi_execute_api",
      arguments: {
        projectId: p.id,
        apiId: p.requests[0].id,
        environmentId: p.plans[0].environmentId,
      },
    });
    assert.notEqual(response.isError, true, response.content?.[0]?.text);
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.status, "passed");
    // The develop-based canonical API returns a plan envelope; the combined
    // newer MCP adapter also reports persistence explicitly. Verify actual
    // fresh disk evidence in both, never infer it from an absent flag.
    if (Object.hasOwn(result, "recordSaved"))
      assert.equal(result.recordSaved, true);
    const step = result.results?.[0] || result;
    assert.equal(JSON.parse(step.response.body).identity, item.identity);
    assert(
      (await app.store.get(p.id)).history.some(
        (r) =>
          r.id === result.id &&
          r.source === "mcp" &&
          r.status === "passed" &&
          JSON.parse(r.response.body).identity === item.identity,
      ),
    );
  }
  await client.close();
  const restoredProjects = [];
  for (const p of projects) {
    const current = await app.store.get(p.id);
    current.requests[0].auth = auth(
      p.identity === "fixture-A" ? "fixture-B" : "fixture-A",
      { addAuthDataToQuery: false },
    );
    current.requests[0].url = "/changed-live-never-requested";
    await app.store.save(current);
    await execute(p);
    const backup = await (
      await fetch(app.url + "/api/projects/" + p.id + "/export", {
        headers: headers(),
      })
    ).json();
    const restoredResponse = await fetch(app.url + "/api/restore", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ document: backup }),
    });
    assert.equal(restoredResponse.status, 201);
    const restored = await restoredResponse.json();
    restoredProjects.push({ id: restored.id, identity: p.identity });
    await execute(restoredProjects.at(-1));
    for (const badFlag of ["true", 1, null]) {
      const invalid = structuredClone(p.source),
        untouched = structuredClone(current);
      invalid.global.global_param.auth.awsv4.addAuthDataToQuery = badFlag;
      assert.throws(() => importIntoProject(current, invalid), /布尔/);
      assert.deepEqual(current, untouched);
    }
    const unsupported = structuredClone(p.source),
      untouched = structuredClone(current);
    unsupported.global.global_param.auth.awsv4.service = "execute-api";
    assert.throws(() => importIntoProject(current, unsupported), /S3/);
    assert.deepEqual(current, untouched);
  }
  await close();
  app = await createApp({ root, port: 0 });
  await Promise.all(restoredProjects.map(execute));
  assert.equal(upstream.captured.length, 10);
  assert(upstream.captured.every((request) => request.valid));
  assert(
    upstream.captured.every(
      (request) => request.headers.authorization === undefined,
    ),
  );
  assert(
    upstream.captured.every(
      (request) =>
        new URL(request.rawURL, upstream.url).searchParams.get(
          "X-Amz-Expires",
        ) === "60",
    ),
  );
  for (const request of upstream.captured)
    for (const value of identities.values())
      assert.equal(
        JSON.stringify({
          url: request.rawURL,
          headers: request.headers,
        }).includes(value.secret),
        false,
      );
});
