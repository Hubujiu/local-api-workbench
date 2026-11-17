// Root integration combinations. Author locally with syntax checks only;
// the HTTP, owner execution and persistence paths run in ordinary CI.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  importDocument,
  importIntoProject,
  normalizeRequest,
  runPlan,
  snapshotPlan,
} from "../src/core.mjs";
import { executeRequest } from "../src/runtime.mjs";
import { createApp } from "../src/server.mjs";
import { applyMCPInput } from "../src/mcp-request-input.mjs";
import { importOpenAPIQuery } from "../src/openapi-query-arrays.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import { nativeSampleExportFixture } from "./fixtures/apipost-sample-export.mjs";

// Reuse the independently authored verifier from aws-query-signature.test.mjs.
// It is private there; importing that test module would register unrelated tests.

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

const auth = () => ({
  type: "aws",
  accessKey: "fixture-A",
  secretKey: identities.get("fixture-A").secret,
  sessionToken: identities.get("fixture-A").token,
  region: "us-east-1",
  service: "s3",
  addAuthDataToQuery: true,
});
const values = ["z,one", "a&two", "+/%", "z,one"];
const wirePairs = ["q=z%2Cone", "q=a%26two", "q=%2B%2F%25", "q=z%2Cone"];
const arrayRow = (value = values, explode = true) =>
  importOpenAPIQuery([
    {
      in: "query",
      name: "q",
      schema: { type: "array", items: { type: "string" } },
      example: value,
      explode,
    },
  ])[0];
async function endpoint(t) {
  const captured = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = {
      method: request.method,
      rawURL: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks),
    };
    const result = verify(input);
    const url = new URL(input.rawURL, "http://local");
    const entry = {
      ...input,
      valid: result.valid,
      values: url.searchParams.getAll("q"),
    };
    captured.push(entry);
    response.writeHead(result.valid ? 200 : 403, {
      "content-type": "application/json",
    });
    response.end(
      JSON.stringify({
        valid: result.valid,
        reason: result.reason,
        rawURL: input.rawURL,
        values: entry.values,
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    url: "http://127.0.0.1:" + server.address().port,
    captured,
  };
}

test("array integration verifier retains the published AWS S3 signature oracle", () => {
  // Same fictional AWS vector as the existing query-signature test suite:
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
  const rawURL =
    "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404";
  const keys = new Map([
    [
      "AKIAIOSFODNN7EXAMPLE",
      {
        secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        token: "",
      },
    ],
  ]);
  const input = {
    method: "GET",
    rawURL,
    headers: { host: "examplebucket.s3.amazonaws.com" },
  };
  const now = Date.parse("2013-05-24T12:00:00Z");
  assert.equal(verify(input, keys, now).valid, true);
  assert.equal(
    verify(
      {
        ...input,
        rawURL: rawURL.replace("test.txt", "changed.txt"),
      },
      keys,
      now,
    ).valid,
    false,
  );
});

test(
  "OAS3 and Swagger multi survive MCP dynamic replacement and actual AWS query signing without sorting or collapsing wire elements",
  { timeout: 15000 },
  async (t) => {
    const server = await endpoint(t);
    const operation = (parameter) => ({
      operationId: "presigned-array",
      parameters: [parameter],
      responses: { 200: { description: "Query-only verifier" } },
    });
    const sources = [
      {
        openapi: "3.0.3",
        info: { title: "Array signing", version: "1" },
        servers: [{ url: server.url }],
        paths: {
          "/object": {
            get: operation({
              in: "query",
              name: "q",
              schema: { type: "array", items: { type: "string" } },
              example: ["stored"],
            }),
          },
        },
      },
      {
        swagger: "2.0",
        info: { title: "Array signing", version: "1" },
        host: new URL(server.url).host,
        schemes: ["http"],
        paths: {
          "/object": {
            get: operation({
              in: "query",
              name: "q",
              type: "array",
              items: { type: "string" },
              collectionFormat: "multi",
              default: ["stored"],
            }),
          },
        },
      },
    ];
    for (const source of sources) {
      const [saved] = importDocument(source);
      saved.auth = auth();
      saved.query[0].dynamic = {
        source: "fixed",
        value: ["MUST-NOT-REPLACE-TEMPORARY-INPUT"],
      };
      const before = structuredClone(saved);
      const temporary = applyMCPInput(saved, { query: { q: values } });
      assert.equal(Object.hasOwn(temporary.query[0], "dynamic"), false);
      const plan = snapshotPlan({ steps: [{ request: temporary }] });
      const frozen = structuredClone(plan);
      const run = await runPlan(plan, {}, executeRequest);
      assert.equal(run.status, "passed", JSON.stringify(run.results));
      const response = run.results[0].response;
      assert.equal(response.status, 200);
      const echo = JSON.parse(response.body);
      assert.equal(echo.valid, true, JSON.stringify(echo));
      assert.deepEqual(echo.values, values);
      assert.deepEqual(
        echo.rawURL
          .slice(echo.rawURL.indexOf("?") + 1)
          .split("&")
          .filter((pair) => pair.startsWith("q=")),
        wirePairs,
      );
      const captured = server.captured.at(-1);
      assert.equal(captured.headers.authorization, undefined);
      assert.equal(verify(captured).valid, true);
      assert.equal(
        verify({
          ...captured,
          rawURL: captured.rawURL.replace("q=a%26two", "q=changed"),
        }).valid,
        false,
      );
      assert.deepEqual(saved, before);
      assert.deepEqual(plan, frozen);
    }
    assert.equal(server.captured.length, sources.length);
  },
);

test(
  "CSV presign guard rejects after dynamic empty baseline resolves and after global or folder auth inheritance, with no outbound request",
  { timeout: 20000 },
  async (t) => {
    const server = await endpoint(t);
    const root = await mkdtemp(path.join(tmpdir(), "query-array-root-"));
    let app;
    t.after(async () => {
      if (app) {
        app.server.closeAllConnections();
        await new Promise((resolve) => app.server.close(resolve));
      }
      await rm(root, { recursive: true, force: true });
    });
    app = await createApp({ root, port: 0 });
    for (const mode of ["own", "global", "folder"]) {
      const project = await app.store.create("CSV guard " + mode);
      project.folders = ["Objects"];
      project.settings =
        mode === "global"
          ? { globalAuth: auth() }
          : mode === "folder"
            ? { globalAuth: { type: "none" }, folderAuth: { Objects: auth() } }
            : {};
      const request = normalizeRequest({
        name: "Dynamic CSV " + mode,
        url: server.url + "/object",
        folder: mode === "folder" ? "Objects" : "",
        auth: mode === "own" ? auth() : { type: "none" },
        query: [
          {
            ...arrayRow([], false),
            dynamic: { source: "fixed", value: values },
          },
        ],
      });
      project.requests = [request];
      await app.store.save(project);
      const before = await app.store.get(project.id);
      const result = await fetch(
        app.url + "/api/projects/" + project.id + "/execute",
        {
          method: "POST",
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          body: JSON.stringify({ request }),
        },
      );
      const failed = await result.json();
      assert.equal(result.status, 200, JSON.stringify(failed));
      assert.equal(failed.outcome, "failed");
      assert.match(failed.error, /CSV数组.*AWS Query预签名/);
      assert.equal(failed.recordSaved, true);
      assert.equal(server.captured.length, 0);
      const after = await app.store.get(project.id);
      assert.deepEqual(after.requests, before.requests);
      assert.deepEqual(after.settings, before.settings);
      assert.equal(after.history.length, before.history.length + 1);
      const recorded = after.history.find(
        (entry) => entry.id === failed.recordId,
      );
      assert.ok(
        recorded,
        "The exact failed execution receipt must be readable",
      );
      assert.equal(recorded.status, "failed");
      assert.match(recorded.error, /AWS Query预签名/);
    }
    const direct = normalizeRequest({
      url: server.url + "/object",
      query: [arrayRow([], false)],
      auth: auth(),
    });
    const before = structuredClone(direct);
    assert.throws(
      () => applyMCPInput(direct, { query: { q: values } }),
      /AWS Query预签名/,
    );
    assert.deepEqual(direct, before);
    assert.equal(server.captured.length, 0);
  },
);

const nativeProject = () => ({
  id: "query-array-native",
  name: "Query array native boundary",
  requests: [
    normalizeRequest({
      id: "api",
      name: "Plain HTTP",
      url: "http://127.0.0.1:1/object",
    }),
  ],
  environments: [],
  folders: [],
  servers: [],
  settings: {},
  cases: [],
  caseFolders: [],
  plans: [],
});
const nativeFormats = [exportApipost, exportApipostDirectory];
const nativeVariants = () => [
  arrayRow(values),
  arrayRow([]),
  { ...arrayRow(values), enabled: false },
  arrayRow(values, false),
  arrayRow([], false),
  { ...arrayRow(values, false), enabled: false },
];
const assertNativeRejects = (encode, project) => {
  const before = structuredClone(project);
  assert.throws(() => encode(project), /schema仅支持明确基础类型|参数未知字段/);
  assert.deepEqual(project, before);
};

test("native JSON and directory reject valid live array definitions, including empty and disabled rows, rather than dropping markers", () => {
  for (const encode of nativeFormats) {
    assert.doesNotThrow(() => encode(nativeProject()));
    for (const row of nativeVariants()) {
      const project = nativeProject();
      project.requests[0].query = [row];
      assert.doesNotThrow(() => normalizeRequest(project.requests[0]));
      assertNativeRejects(encode, project);
    }
  }
});

test("native JSON and directory reject valid array markers in frozen samples without relying on live API rejection", () => {
  const project = nativeProject();
  project.requests = [];
  importIntoProject(project, nativeSampleExportFixture());
  for (const encode of nativeFormats) {
    assert.doesNotThrow(() => encode(project));
    for (const row of nativeVariants()) {
      const candidate = structuredClone(project);
      candidate.cases[0].request.query = [row];
      assert.equal(
        candidate.requests.every((request) =>
          request.query.every(
            (value) => !Object.hasOwn(value, "querySerialization"),
          ),
        ),
        true,
      );
      assert.doesNotThrow(() => normalizeRequest(candidate.cases[0].request));
      assertNativeRejects(encode, candidate);
    }
  }
});

test("native directory rejects array markers present only in independent frozen plan snapshots", () => {
  const project = nativeProject();
  project.environments = [{ id: "env", name: "Environment", variables: {} }];
  project.plans = [
    snapshotPlan({
      id: "plan",
      name: "Frozen native boundary",
      environmentId: "env",
      statusPolicy: "strict200",
      steps: [{ request: project.requests[0] }],
    }),
  ];
  assert.doesNotThrow(() => exportApipostDirectory(project));
  for (const row of nativeVariants()) {
    const candidate = structuredClone(project);
    candidate.plans[0].steps[0].request.query = [row];
    assert.deepEqual(candidate.requests[0].query, []);
    assert.doesNotThrow(() =>
      normalizeRequest(candidate.plans[0].steps[0].request),
    );
    assertNativeRejects(exportApipostDirectory, candidate);
  }
});
