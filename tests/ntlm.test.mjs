import test from "node:test";
import assert from "node:assert/strict";
import {
  ntlmType1,
  parseNtlmChallenge,
  ntlmType3,
  ntlmV2Response,
} from "../src/ntlm.mjs";
const targetInfo = Buffer.from(
  "02000c0044006f006d00610069006e0001000c0053006500720076006500720000000000",
  "hex",
);
const credentials = {
  username: "User",
  password: "Password",
  domain: "Domain",
  workstation: "COMPUTER",
};
const challenge = (flags = 0xa0888205, info = targetInfo) => {
  const b = Buffer.alloc(48 + info.length);
  b.write("NTLMSSP\0");
  b.writeUInt32LE(2, 8);
  b.writeUInt32LE(flags >>> 0, 20);
  Buffer.from("0123456789abcdef", "hex").copy(b, 24);
  b.writeUInt16LE(info.length, 40);
  b.writeUInt16LE(info.length, 42);
  b.writeUInt32LE(48, 44);
  info.copy(b, 48);
  return "NTLM " + b.toString("base64");
};
test("NTLMv2 responses match the Microsoft MS-NLMP4.2.4 fixed calculation vector", () => {
  const r = ntlmV2Response(
    credentials,
    Buffer.from("0123456789abcdef", "hex"),
    targetInfo,
    { clientChallenge: Buffer.alloc(8, 0xaa), timestamp: Buffer.alloc(8) },
  );
  assert.equal(r.key.toString("hex"), "0c868a403bfd7a93a3001ef22ef02e3f");
  assert.equal(
    r.lm.toString("hex"),
    "86c35097ac9cec102554764a57cccc19aaaaaaaaaaaaaaaa",
  );
  assert.equal(
    r.nt.subarray(0, 16).toString("hex"),
    "68cd0ab851e51c96aabc927bebef6a1c",
  );
});
test("bounded NTLM messages require v2 and reject malformed or unsupported protections", () => {
  const type1 = Buffer.from(ntlmType1(credentials).slice(5), "base64");
  assert.equal(type1.readUInt32LE(8), 1);
  const parsed = parseNtlmChallenge(challenge());
  const a = ntlmType3(parsed, credentials),
    b = ntlmType3(parsed, credentials);
  assert.notEqual(a, b);
  assert.equal(Buffer.from(a.slice(5), "base64").readUInt32LE(8), 3);
  for (const text of [
    "NTLM !!!!",
    "NTLM AA==",
    challenge(0x201),
    challenge(0xa0888205, Buffer.from("060004000400000000000000", "hex")),
    challenge(
      0xa0888205,
      Buffer.from("0a0010000000000000000000000000000000000000000000", "hex"),
    ),
  ])
    assert.throws(() => parseNtlmChallenge(text));
  const bad = Buffer.from(challenge().slice(5), "base64");
  bad.writeUInt32LE(0xfffffff0, 44);
  assert.throws(() => parseNtlmChallenge("NTLM " + bad.toString("base64")));
  assert.throws(() => ntlmType1({ ...credentials, domain: "bad\\domain" }));
});

test("real NTLMv2 HTTP exchange stays on one socket and independently verifies the proof", async (t) => {
  const http = await import("node:http");
  const { createHmac } = await import("node:crypto");
  const { executeRequest } = await import("../src/runtime.mjs");
  const sockets = new Set(),
    messages = [];
  const server = http.createServer(async (req, res) => {
    sockets.add(req.socket);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const token = Buffer.from(
      (req.headers.authorization || "").slice(5),
      "base64",
    );
    const type = token.readUInt32LE(8);
    messages.push({ type, body: Buffer.concat(chunks).toString() });
    if (type === 1) {
      res.writeHead(401, {
        "www-authenticate": challenge(),
        connection: "keep-alive",
      });
      res.end();
      return;
    }
    const length = token.readUInt16LE(20),
      offset = token.readUInt32LE(24),
      nt = token.subarray(offset, offset + length);
    const proof = createHmac(
      "md5",
      Buffer.from("0c868a403bfd7a93a3001ef22ef02e3f", "hex"),
    )
      .update(
        Buffer.concat([
          Buffer.from("0123456789abcdef", "hex"),
          nt.subarray(16),
        ]),
      )
      .digest();
    res.statusCode = proof.equals(nt.subarray(0, 16)) ? 200 : 403;
    res.end("verified");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const result = await executeRequest({
    url: "http://127.0.0.1:" + server.address().port,
    method: "POST",
    bodyType: "raw",
    body: "fixture-body",
    auth: { type: "ntlm", ...credentials },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body, "verified");
  assert.equal(result.authHandshake.roundTrips, 2);
  assert.equal(sockets.size, 1);
  assert.deepEqual(messages, [
    { type: 1, body: "fixture-body" },
    { type: 3, body: "fixture-body" },
  ]);
});
test("NTLM refuses downgraded challenges and replacement sockets, with no redirect credential retry", async (t) => {
  const http = await import("node:http");
  const { executeRequest } = await import("../src/runtime.mjs");
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    req.resume();
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "http://example.invalid" });
      res.end();
      return;
    }
    res.writeHead(401, {
      "www-authenticate": challenge(req.url === "/weak" ? 0x201 : 0xa0888205),
      connection: "close",
    });
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const url = "http://127.0.0.1:" + server.address().port;
  const auth = { type: "ntlm", ...credentials };
  await assert.rejects(
    executeRequest({ url: url + "/weak", auth }),
    /NTLMv2|降级/,
  );
  assert.equal(requests, 1);
  await assert.rejects(
    executeRequest({ url: url + "/close", auth }),
    /连接|socket|NTLM/,
  );
  assert.equal(requests, 2);
  assert.equal(
    (await executeRequest({ url: url + "/redirect", auth })).status,
    302,
  );
  assert.equal(requests, 3);
  await assert.rejects(
    executeRequest({ url, auth, httpVersion: "2" }),
    /HTTP\/1.1/,
  );
  await assert.rejects(
    executeRequest({ url, auth, proxy: "http://127.0.0.1:1" }),
    /代理/,
  );
  assert.equal(requests, 3);
});

test("NTLM preserves TLS trust, total timeout and in-flight cancellation", async (t) => {
  const https = await import("node:https");
  const { readFile } = await import("node:fs/promises");
  const { executeRequest } = await import("../src/runtime.mjs");
  const key = await readFile(
      new URL("./fixtures/localhost.key", import.meta.url),
    ),
    cert = await readFile(new URL("./fixtures/localhost.crt", import.meta.url));
  let authenticated;
  const ready = new Promise((r) => {
    authenticated = r;
  });
  const server = https.createServer({ key, cert }, (req, res) => {
    req.resume();
    const token = Buffer.from(
      (req.headers.authorization || "").slice(5),
      "base64",
    );
    if (token.readUInt32LE(8) === 1) {
      res.writeHead(401, {
        "www-authenticate": challenge(),
        connection: "keep-alive",
      });
      res.end();
      return;
    }
    if (req.url === "/cancel") {
      authenticated();
      return;
    }
    if (req.url === "/timeout") return;
    res.end("tls-verified");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const url = "https://127.0.0.1:" + server.address().port;
  const auth = { type: "ntlm", ...credentials };
  await assert.rejects(
    executeRequest({ url, auth }),
    /certificate|self.signed/i,
  );
  assert.equal(
    (await executeRequest({ url, auth, tls: { ca: cert.toString() } })).body,
    "tls-verified",
  );
  await assert.rejects(
    executeRequest({
      url: url + "/timeout",
      auth,
      tls: { ca: cert.toString() },
      timeout: 100,
    }),
    /超时/,
  );
  const controller = new AbortController();
  const pending = assert.rejects(
    executeRequest(
      { url: url + "/cancel", auth, tls: { ca: cert.toString() } },
      controller.signal,
    ),
    /abort/i,
  );
  await ready;
  controller.abort();
  await pending;
});
test("late peer close cannot send Type3 on a newly allocated connection", async (t) => {
  const http = await import("node:http");
  const { executeRequest } = await import("../src/runtime.mjs");
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    req.resume();
    res.writeHead(401, {
      "www-authenticate": challenge(),
      connection: "keep-alive",
    });
    res.end("", () => req.socket.end());
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  await assert.rejects(
    executeRequest(
      {
        url: "http://127.0.0.1:" + server.address().port,
        auth: { type: "ntlm", ...credentials },
      },
      undefined,
      {
        cookieSession: {
          header: async () => null,
          capture: async () => new Promise((r) => setTimeout(r, 40)),
        },
      },
    ),
    /连接|socket|NTLM/,
  );
  assert.equal(requests, 1);
});
