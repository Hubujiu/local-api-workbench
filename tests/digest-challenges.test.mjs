import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { executeRequest } from "../src/runtime.mjs";

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
export async function challengeOrigin(t, challenges, expected) {
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
export const requestFor = (url) => ({
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
