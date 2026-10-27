import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { executeRequest, Store } from "../src/runtime.mjs";
import { digestAuthorization } from "../src/digest.mjs";
import { createApp } from "../src/server.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const credentials = {
  type: "digest",
  username: "fixture-user",
  password: "fixture-password",
};
const quote = (value) => JSON.stringify(value);
const offer = ({
  realm = "fixture",
  nonce = "fixture-nonce",
  algorithm = "SHA-256",
  qop = "auth-int",
  opaque,
} = {}) =>
  `Digest realm=${quote(realm)}, nonce=${quote(nonce)}, algorithm=${algorithm}${qop === undefined ? "" : `, qop=${quote(qop)}`}${opaque === undefined ? "" : `, opaque=${quote(opaque)}`}`;
// Independent authorization-only oracle: does not import the production parser
// or signing helper, and hashes the entity actually received by the server.
function verify(header, req, body, expected) {
  if (!header?.startsWith("Digest ")) return false;
  const fields = {};
  const pattern =
    /(?:^|,\s*)([A-Za-z][A-Za-z0-9-]*)=("(?:\\.|[^"\\])*"|[^,\s]+)/gy;
  let offset = 7;
  while (offset < header.length) {
    pattern.lastIndex = offset === 7 ? 0 : offset - 7;
    const match = pattern.exec(header.slice(7));
    if (!match || Object.hasOwn(fields, match[1])) return false;
    fields[match[1]] = match[2].startsWith('"')
      ? JSON.parse(match[2])
      : match[2];
    offset = pattern.lastIndex + 7;
  }
  const algorithm = expected.algorithm || "MD5";
  const name = { MD5: "md5", "SHA-256": "sha256", "SHA-512-256": "sha512-256" }[
    algorithm.toUpperCase().replace(/-SESS$/, "")
  ];
  const hash = (data) => createHash(name).update(data).digest("hex");
  const qop =
    expected.qop === undefined
      ? undefined
      : expected.qop
            .split(",")
            .map((x) => x.trim())
            .includes("auth")
        ? "auth"
        : "auth-int";
  let identity = hash(
    `${credentials.username}:${expected.realm}:${credentials.password}`,
  );
  if (/-sess$/i.test(algorithm))
    identity = hash(`${identity}:${expected.nonce}:${fields.cnonce}`);
  const entity = hash(
    `${req.method}:${req.url}${qop === "auth-int" ? ":" + hash(body) : ""}`,
  );
  const response = hash(
    qop
      ? [identity, expected.nonce, fields.nc, fields.cnonce, qop, entity].join(
          ":",
        )
      : [identity, expected.nonce, entity].join(":"),
  );
  return (
    fields.username === credentials.username &&
    fields.realm === expected.realm &&
    fields.nonce === expected.nonce &&
    fields.algorithm === algorithm.toUpperCase() &&
    fields.qop === qop &&
    fields.uri === req.url &&
    fields.response === response &&
    fields.opaque === expected.opaque &&
    (!qop || fields.nc === "00000001")
  );
}
async function challengeOrigin(t, challenges, expected) {
  const requests = [],
    failures = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const accepted =
        !!expected && verify(req.headers.authorization, req, body, expected);
      requests.push({
        body,
        contentType: req.headers["content-type"],
        authorized: !!req.headers.authorization,
        accepted,
      });
      res.writeHead(accepted ? 200 : 401, {
        "WWW-Authenticate": challenges,
        Connection: "close",
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ accepted }));
    } catch (error) {
      failures.push(error.message);
      res.writeHead(500);
      res.end("fixture error");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(failures, []);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/entity?original=yes`,
    requests,
  };
}
const selected = {
  realm: "fixture",
  nonce: "fixture-nonce",
  algorithm: "SHA-256",
  qop: "auth-int",
};
const requestFor = (url) => ({
  url,
  method: "POST",
  auth: credentials,
  bodyType: "form-data",
  form: [
    { key: "text", value: "中, body" },
    { key: "file", type: "file", filename: "fixture.bin", value: "AP8NCg==" },
  ],
  timeout: 3000,
});
function assertReplay(target) {
  assert.equal(target.requests.length, 2);
  const [first, second] = target.requests;
  assert.equal(first.authorized, false);
  assert.equal(second.accepted, true);
  assert.deepEqual(second.body, first.body);
  assert.equal(second.contentType, first.contentType);
}

for (const [name, challenges, expected] of [
  [
    "Basic before Digest on separate header lines",
    ['Basic realm="fallback"', offer()],
    selected,
  ],
  [
    "Basic after Digest on separate header lines",
    [offer(), 'Basic realm="fallback"'],
    selected,
  ],
  [
    "combined header and token68 distractors",
    `Negotiate YWJjZA==, Bearer abc+/~._-==, Basic realm="fallback", ${offer()}, Other`,
    selected,
  ],
  [
    "empty list members and mixed-case scheme/parameter names",
    `, , Basic realm="fallback",, ${offer().replace("Digest realm", "dIgEsT ReAlM")}, ,`,
    selected,
  ],
  [
    "first supported algorithm follows server preference",
    [offer(), offer({ algorithm: "MD5", realm: "other", nonce: "other" })],
    selected,
  ],
  [
    "server can prefer MD5 without field contamination",
    [offer({ algorithm: "MD5" }), offer()],
    { ...selected, algorithm: "MD5" },
  ],
  [
    "unsupported algorithm before supported",
    [offer({ algorithm: "unknown" }), offer()],
    selected,
  ],
  [
    "unsupported qop before supported",
    [offer({ algorithm: "SHA-512-256", qop: "unknown" }), offer()],
    selected,
  ],
  [
    "quoted commas escapes and qop list stay in one challenge",
    [
      'Basic realm="wrong, realm"',
      offer({
        realm: 'fixture, "realm"\\tail',
        nonce: 'nonce, "quoted"\\end',
        qop: "auth-int, auth",
        opaque: 'opaque, "a"\\b',
      }),
      'Basic realm="last"',
    ],
    {
      realm: 'fixture, "realm"\\tail',
      nonce: 'nonce, "quoted"\\end',
      algorithm: "SHA-256",
      qop: "auth-int, auth",
      opaque: 'opaque, "a"\\b',
    },
  ],
  [
    "empty realm and opaque are retained",
    [offer({ realm: "", opaque: "" })],
    { ...selected, realm: "", opaque: "" },
  ],
  [
    "escaped backslash before quoted comma",
    [offer({ realm: "back\\,comma" })],
    { ...selected, realm: "back\\,comma" },
  ],
  [
    "BWS and token-valued parameters",
    'Digest realm \t= fixture, nonce=fixture-nonce, algorithm="SHA-256", qop=auth-int',
    selected,
  ],
  [
    "legacy omitted algorithm and qop",
    'Digest realm="fixture", nonce="fixture-nonce"',
    { ...selected, algorithm: "MD5", qop: undefined },
  ],
  [
    "session algorithm without qop",
    'Digest realm="fixture", nonce="fixture-nonce", algorithm=SHA-256-sess',
    { ...selected, algorithm: "SHA-256-sess", qop: undefined },
  ],
  ...[
    "MD5",
    "SHA-256",
    "SHA-512-256",
    "MD5-sess",
    "SHA-256-sess",
    "SHA-512-256-sess",
  ].map((algorithm) => [
    `${algorithm} auth-int`,
    [offer({ algorithm })],
    { ...selected, algorithm },
  ]),
]) {
  test(`Digest challenge selection: ${name}`, async (t) => {
    const target = await challengeOrigin(t, challenges, expected);
    const request = requestFor(target.url),
      before = structuredClone(request);
    const result = await executeRequest(request);
    assert.equal(result.status, 200);
    assertReplay(target);
    assert.deepEqual(request, before);
  });
}

for (const [name, challenges] of [
  [
    "empty algorithm is not omitted MD5",
    `${offer().replace("algorithm=SHA-256", 'algorithm=""')}, Digest realm="other", nonce="other"`,
  ],
  ["case-insensitive duplicate realm", `${offer()}, REALM="contaminated"`],
  ["duplicate nonce", `${offer()}, nonce="other"`],
  ["duplicate extension", `${offer()}, x-extension=a, X-Extension=b`],
  ["unterminated quoted string", `${offer()}, opaque="broken`],
  ["missing parameter value", `${offer()}, opaque=`],
  ["garbage after quoted value", `${offer()}, opaque="ok"garbage`],
  [
    "missing nonce cannot borrow from Basic",
    'Digest realm="fixture", algorithm=SHA-256, Basic nonce="other"',
  ],
  [
    "missing realm cannot borrow from Basic",
    'Digest nonce="nonce", algorithm=SHA-256, Basic realm="other"',
  ],
  ["token68 is not a Digest challenge", `Digest YWJjZA==, ${offer()}`],
  [
    "malformed preferred challenge does not downgrade",
    [`${offer()}, nonce="duplicate"`, offer({ algorithm: "MD5" })],
  ],
]) {
  test(`Digest rejects malformed challenge before replay: ${name}`, async (t) => {
    const target = await challengeOrigin(t, challenges, selected);
    await assert.rejects(executeRequest(requestFor(target.url)), /Digest|认证/);
    assert.equal(target.requests.length, 1);
    assert.equal(target.requests[0].authorized, false);
  });
}

test("no Digest means no replay and no Basic fallback", async (t) => {
  const target = await challengeOrigin(t, [
    'Basic realm="fallback"',
    "Bearer abc==",
  ]);
  assert.equal((await executeRequest(requestFor(target.url))).status, 401);
  assert.equal(target.requests.length, 1);
  assert.equal(target.requests[0].authorized, false);
});
test("authenticated failure never triggers a third request", async (t) => {
  const target = await challengeOrigin(t, ['Basic realm="fallback"', offer()]);
  assert.equal((await executeRequest(requestFor(target.url))).status, 401);
  assert.equal(target.requests.length, 2);
});

test("Digest direct parser bounds, full tokens, header arrays and literal quoted-pairs", () => {
  const sign = (header) =>
    digestAuthorization(header, credentials, "GET", "/", "", "fixture-cnonce");
  for (const header of [
    'Digest realm="x", nonce="n\r\n"',
    'Digest realm="x", nonce="n\u007f"',
    'Digest realm="x", nonce="n\u0100"',
    'Digest realm="x", nonce="n", qop="auth;invalid"',
    'Digest realm="x", nonce="n", algorithm=""',
    'Digest realm="x", nonce="n", algorithm=MD5/',
    offer() +
      ", " +
      Array.from({ length: 65 }, (_, i) => `extension${i}=value`).join(", "),
    Array.from({ length: 65 }, () => "Basic"),
    ",".repeat(514) + offer(),
    offer({ realm: "x".repeat(16384) }),
    { arbitrary: true },
  ])
    assert.throws(() => sign(header), /Digest/);
  assert.equal(sign(["Basic realm=ignored", "Bearer abc=="]), null);
  assert.match(sign(["Basic realm=ignored", offer()]), /^Digest /);
  assert.match(
    sign('Digest realm="escaped\\!pair", nonce="x", qop=auth'),
    /realm="escaped!pair"/,
  );
});

for (const transport of ["owner", "mcp-http", "mcp-stdio"]) {
  test(
    `Digest combined challenges authenticate through ${transport} with isolated persisted requests`,
    { timeout: 15000 },
    async (t) => {
      const target = await challengeOrigin(
        t,
        ['Basic realm="fallback"', offer()],
        selected,
      );
      const malformedTarget = await challengeOrigin(
        t,
        [offer() + ', NONCE="duplicate"'],
        selected,
      );
      const noDigest = await challengeOrigin(t, [
        'Basic realm="fallback"',
        "Bearer abc==",
      ]);
      const root = await mkdtemp(path.join(tmpdir(), "digest-challenge-path-"));
      const app =
        transport === "mcp-stdio" ? null : await createApp({ root, port: 0 });
      const store = app?.store || new Store(root);
      await store.init();
      let client;
      t.after(async () => {
        if (client) await client.close();
        if (app) {
          app.server.closeAllConnections();
          await new Promise((resolve) => app.server.close(resolve));
        }
        await rm(root, { recursive: true, force: true });
      });
      const project = await store.create("Digest selected transport");
      const deniedProject = await store.create("Not granted");
      project.requests = [target, malformedTarget, noDigest].map(
        (fixture, i) => ({
          ...requestFor(fixture.url),
          id: "digest-" + i,
          name: "Digest fixture " + i,
        }),
      );
      await store.save(project);
      const before = structuredClone((await store.get(project.id)).requests);
      const owner = async (route, data) =>
        fetch(app.url + route, {
          method: "POST",
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          body: JSON.stringify(data),
        });
      if (transport !== "owner") {
        client = new Client(
          { name: "digest-auth-fixture", version: "1.0.0" },
          { capabilities: {} },
        );
        if (transport === "mcp-http") {
          const configured = await owner("/api/mcp/config", {
            enabled: true,
            projects: [project.id],
            execute: true,
            write: true,
            remember: false,
          });
          assert.equal(configured.status, 200);
          const { token } = await configured.json();
          await client.connect(
            new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
              requestInit: { headers: { Authorization: "Bearer " + token } },
            }),
          );
        } else {
          await client.connect(
            new StdioClientTransport({
              command: process.execPath,
              args: [
                fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
                "--project",
                project.id,
                "--execute",
                "--write",
              ],
              env: { LOCAL_API_DATA: root },
              stderr: "pipe",
            }),
          );
        }
        const rejected = await client.callTool({
          name: "localapi_execute_api",
          arguments: { projectId: deniedProject.id, apiId: "digest-0" },
        });
        assert.equal(rejected.isError, true);
        assert.equal(target.requests.length, 0);
      } else {
        const forbidden = await fetch(
          app.url + "/api/projects/" + project.id + "/execute",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ request: project.requests[0] }),
          },
        );
        assert.equal(forbidden.status, 403);
        assert.equal(target.requests.length, 0);
      }
      for (let i = 0; i < project.requests.length; i++) {
        if (transport === "owner") {
          const response = await owner(
            "/api/projects/" + project.id + "/execute",
            { request: project.requests[i] },
          );
          const value = await response.json();
          if (i === 1) assert(value.error || value.status === 0);
          else assert.equal(value.status, i === 0 ? 200 : 401);
        } else {
          const result = await client.callTool({
            name: "localapi_execute_api",
            arguments: { projectId: project.id, apiId: "digest-" + i },
          });
          if (i === 1) {
            const value = JSON.parse(result.content[0].text);
            assert(result.isError || value.status === "failed");
          } else {
            assert.notEqual(result.isError, true);
            const value = JSON.parse(result.content[0].text);
            assert.equal(value.results[0].response.status, i === 0 ? 200 : 401);
          }
        }
      }
      assertReplay(target);
      assert.equal(malformedTarget.requests.length, 1);
      assert.equal(malformedTarget.requests[0].authorized, false);
      assert.equal(noDigest.requests.length, 1);
      assert.equal(noDigest.requests[0].authorized, false);
      assert.deepEqual(
        (await new Store(root).get(project.id)).requests,
        before,
      );
    },
  );
}

test("combined Digest challenge cannot replay after cancellation or shared deadline exhaustion", async (t) => {
  for (const mode of ["cancel", "deadline"]) {
    const target = await challengeOrigin(
      t,
      ['Basic realm="fallback"', offer()],
      selected,
    );
    const controller = new AbortController();
    await assert.rejects(
      executeRequest(
        { ...requestFor(target.url), timeout: 100 },
        controller.signal,
        {
          cookieSession: {
            header: async () => null,
            capture: async () => {
              if (mode === "cancel") controller.abort();
              else await new Promise((resolve) => setTimeout(resolve, 140));
            },
          },
        },
      ),
      mode === "cancel" ? /取消|abort/i : /超时/,
    );
    assert.equal(target.requests.length, 1);
    assert.equal(target.requests[0].authorized, false);
  }
});
