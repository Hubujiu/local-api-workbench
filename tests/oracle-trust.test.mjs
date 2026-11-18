import test from "node:test";
import assert from "node:assert/strict";
import tls from "node:tls";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { validateOracleReadTrust } from "../src/oracle-read-trust.mjs";
import { queryOracleRead } from "../src/oracle-read-process.mjs";
import { oracleInput } from "./helpers/oracle-fixture.mjs";

const fixture = (file) =>
  readFile(new URL("./fixtures/" + file, import.meta.url), "utf8");
const ca = await fixture("localhost.crt");
const wrongCA = await fixture("sqlserver-wrong-host.crt");
const key = await fixture("oracle-fixture.key");
const valid = await fixture("oracle-valid.crt");
const expired = await fixture("oracle-expired.crt");
// Parse at module load: an empty/malformed certificate must never become a
// missing-certificate TLS rejection and masquerade as certificate validation.
const rootCertificate = new X509Certificate(ca);
const validCertificate = new X509Certificate(valid);
const expiredCertificate = new X509Certificate(expired);
assert.ok(rootCertificate.ca);
for (const certificate of [validCertificate, expiredCertificate]) {
  assert.equal(certificate.ca, false);
  assert.equal(certificate.subject, "CN=localhost");
  assert.equal(certificate.issuer, rootCertificate.subject);
  assert.ok(certificate.checkIssued(rootCertificate));
  assert.ok(certificate.verify(rootCertificate.publicKey));
  assert.ok(certificate.checkPrivateKey(createPrivateKey(key)));
  assert.ok(certificate.validFromDate.getTime() < Date.now());
  assert.notEqual(certificate.fingerprint256, rootCertificate.fingerprint256);
}
assert.ok(validCertificate.validToDate.getTime() > Date.now());
assert.ok(expiredCertificate.validToDate.getTime() < Date.now());
assert.notEqual(
  validCertificate.fingerprint256,
  expiredCertificate.fingerprint256,
);

const trustFor = (input, root = ca) => ({
  host: input.connection.host,
  port: input.connection.port ?? 2484,
  database: input.connection.database,
  serverDN: input.connection.serverDN,
  ca: root,
});
test("operator trust validates bounded exact endpoint and root without invoking accessors", () => {
  const input = oracleInput(),
    trust = trustFor(input);
  assert.equal(validateOracleReadTrust(input, trust).ca, ca);
  assert.equal(validateOracleReadTrust(input, undefined), undefined);
  for (const patch of [
    { host: "other.invalid" },
    { port: 443 },
    { database: "OTHER" },
    { serverDN: "CN=other.invalid" },
    { ca: wrongCA + ca },
    { ca: key },
    { ca: ca + key },
    { ca: "x".repeat(20000) },
    { ca: expired },
    { walletContent: ca },
    { ca: "not-a-certificate" },
  ])
    assert.throws(
      () => validateOracleReadTrust(input, { ...trust, ...patch }),
      /TRUST_INVALID/,
    );
  let invoked = false;
  const accessor = { ...trust };
  Object.defineProperty(accessor, "ca", {
    get() {
      invoked = true;
      return ca;
    },
  });
  assert.throws(
    () => validateOracleReadTrust(input, accessor),
    /TRUST_INVALID/,
  );
  assert.equal(invoked, false);
});
async function probe({
  certificate = valid,
  root = ca,
  dn = "CN=localhost",
  trusted = true,
} = {}) {
  const sockets = new Set(),
    packets = [],
    tlsErrors = [];
  let secure = 0,
    attempts = 0;
  assert.ok(
    new X509Certificate(certificate).checkPrivateKey(createPrivateKey(key)),
  );
  const server = tls.createServer({ key, cert: certificate }, (socket) => {
    secure++;
    socket.on("data", (data) => {
      packets.push(Buffer.from(data));
      socket.destroy();
    });
  });
  server.on("connection", (socket) => {
    attempts++;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("tlsClientError", (error) =>
    tlsErrors.push(error.code + ":" + error.message),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const input = oracleInput();
  input.connection.host = "127.0.0.1";
  input.connection.port = server.address().port;
  input.connection.serverDN = dn;
  try {
    await assert.rejects(
      queryOracleRead(input, trusted ? { trust: trustFor(input, root) } : {}),
      (error) =>
        error.code.startsWith("ORACLE_READ_") &&
        !String(error).includes("private-secret") &&
        !String(error).includes("BEGIN CERTIFICATE"),
    );
    return { secure, attempts, packets, tlsErrors };
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}
test("official Thin worker accepts only the explicit CA and exact DN, leaves parent trust unchanged", async () => {
  const before = tls.getCACertificates("default");
  const positive = await probe();
  assert.equal(positive.attempts, 1);
  assert.equal(positive.secure, 1);
  assert.ok(
    positive.packets.length > 0,
    "expected TNS connect only after authenticated TLS",
  );
  for (const packet of positive.packets)
    assert.ok(!packet.includes(Buffer.from("private-secret")));
  assert.deepEqual(tls.getCACertificates("default"), before);

  for (const options of [
    { root: wrongCA },
    { dn: "CN=wrong.invalid" },
    { certificate: expired },
    { trusted: false },
  ]) {
    const negative = await probe(options);
    assert.equal(negative.attempts, 1);
    assert.equal(negative.packets.length, 0);
    assert.deepEqual(tls.getCACertificates("default"), before);
  }
});
test("query or connection input cannot smuggle operator CA or runtime options", async () => {
  const input = oracleInput();
  for (const invalid of [
    { ...input, trust: trustFor(input) },
    { ...input, connection: { ...input.connection, ca } },
    { ...input, connection: { ...input.connection, walletContent: ca } },
    {
      ...input,
      connection: { ...input.connection, rejectUnauthorized: false },
    },
  ])
    await assert.rejects(queryOracleRead(invalid), /INPUT_INVALID/);
});

test("unsupported Node TLS API fails closed instead of using default or ambient trust", async () => {
  const original = tls.setDefaultCACertificates;
  try {
    tls.setDefaultCACertificates = undefined;
    const input = oracleInput();
    await assert.rejects(queryOracleRead(input, { trust: trustFor(input) }), {
      code: "ORACLE_READ_TRUST_RUNTIME_UNSUPPORTED",
    });
  } finally {
    tls.setDefaultCACertificates = original;
  }
});

test("operator root validity window is enforced before process creation", () => {
  const input = oracleInput(),
    certificate = new X509Certificate(ca);
  const original = Date.now;
  try {
    for (const now of [
      certificate.validFromDate.getTime() - 1,
      certificate.validToDate.getTime() + 1,
    ]) {
      Date.now = () => now;
      assert.throws(
        () => validateOracleReadTrust(input, trustFor(input)),
        /TRUST_INVALID/,
      );
    }
  } finally {
    Date.now = original;
  }
});

test("expired leaf has a concrete CERT_HAS_EXPIRED TLS rejection, not a missing-certificate handshake", async () => {
  const sockets = new Set();
  const server = tls.createServer({ key, cert: expired });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("tlsClientError", () => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(
      new Promise((resolve, reject) => {
        const socket = tls.connect({
          host: "127.0.0.1",
          port: server.address().port,
          ca,
          servername: "localhost",
          rejectUnauthorized: true,
        });
        socket.once("error", reject);
        socket.once("secureConnect", () => {
          socket.destroy();
          resolve();
        });
        socket.setTimeout(2000, () => {
          socket.destroy();
          reject(Error("TLS_PROBE_TIMEOUT"));
        });
      }),
      { code: "CERT_HAS_EXPIRED" },
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
