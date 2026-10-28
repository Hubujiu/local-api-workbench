import test from "node:test";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { oracleReadCACertificate } from "../src/oracle-read-ca.mjs";
import { oracleReadInput } from "../src/oracle-read-config.mjs";

// Existing intentionally public loopback CA; no private key is read/generated,
// no trust store is modified, and no TLS/Oracle connection is made.
const fixture = readFileSync(
  new URL("./fixtures/localhost.crt", import.meta.url),
  "utf8",
);
const certificate = new X509Certificate(fixture);
const now = Date.parse("2026-10-28T00:00:00Z");
const pem = (der) =>
  `-----BEGIN CERTIFICATE-----\n${der
    .toString("base64")
    .match(/.{1,64}/g)
    .join("\n")}\n-----END CERTIFICATE-----\n`;
const input = (patch = {}) => ({
  host: "db.example.test",
  port: 1521,
  service: "FREEPDB1",
  user: "reader",
  password: "request-only secret",
  ssl: true,
  sql: "SELECT 1 FROM DUAL",
  ...patch,
});

test("Oracle CA parser accepts absence only when the argument is omitted", () => {
  assert.equal(oracleReadCACertificate(), undefined);
  for (const value of [undefined, null, "", 1, {}, Buffer.from(fixture)])
    assert.throws(() => oracleReadCACertificate(value, { now }));
});

test("Oracle CA parser canonicalizes one currently valid public CA certificate", () => {
  assert.equal(certificate.ca, true);
  assert.equal(certificate.subject, "CN=localhost");
  for (const value of [
    fixture,
    fixture.trimEnd(),
    fixture.replaceAll("\n", "\r\n"),
    pem(certificate.raw).replaceAll(/(?<!-)\n(?=[A-Za-z0-9+/])/g, ""),
  ]) {
    assert.equal(
      oracleReadCACertificate(value, { now }),
      certificate.toString(),
    );
  }
});

test("Oracle CA parser rejects garbage, extra blocks, paths and private-key labels", () => {
  for (const value of [
    "certificate.pem",
    "/tmp/public-ca.pem",
    "https://example.test/ca.pem",
    `garbage\n${fixture}`,
    `${fixture}garbage`,
    `\n${fixture}`,
    `${fixture}\n`,
    `${fixture}${fixture}`,
    `${fixture}-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----\n`,
    fixture.replaceAll("CERTIFICATE", "TRUSTED CERTIFICATE"),
    fixture.replaceAll("CERTIFICATE", "PRIVATE KEY"),
    fixture.replace("MIID", "MI\0D"),
    fixture.replace("MIID", "MIéD"),
    fixture.replace("MIID", "MI\ud800D"),
    fixture.replace("MIID", "MI ID"),
    "x".repeat(16 * 1024 + 1),
  ])
    assert.throws(
      () => oracleReadCACertificate(value, { now }),
      /Oracle WIP CA/,
    );
});

test("Oracle CA parser requires canonical base64 and complete DER consumption", () => {
  const base64 = certificate.raw.toString("base64");
  assert.ok(base64.endsWith("="));
  // This fixture has a single padding character: altering the unused low bits
  // keeps Buffer's permissively decoded bytes unchanged but is noncanonical.
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const index = alphabet.indexOf(base64.at(-2));
  const noncanonical = `${base64.slice(0, -2)}${alphabet[index + 1]}=`;
  assert.deepEqual(Buffer.from(noncanonical, "base64"), certificate.raw);
  for (const body of [
    base64.slice(0, -1),
    `${base64}=`,
    noncanonical,
    `${base64.slice(0, 8)}!${base64.slice(8)}`,
    "AA==",
  ])
    assert.throws(() =>
      oracleReadCACertificate(
        `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`,
        { now },
      ),
    );
  for (const suffix of [Buffer.from([0]), certificate.raw])
    assert.throws(() =>
      oracleReadCACertificate(pem(Buffer.concat([certificate.raw, suffix])), {
        now,
      }),
    );
  assert.throws(() =>
    oracleReadCACertificate(pem(certificate.raw.subarray(0, -1)), { now }),
  );
});

test("Oracle CA parser requires CA:true and inclusive certificate validity", () => {
  const from = Date.parse(certificate.validFrom);
  const to = Date.parse(certificate.validTo);
  assert.equal(
    oracleReadCACertificate(fixture, { now: from }),
    certificate.toString(),
  );
  assert.equal(
    oracleReadCACertificate(fixture, { now: to }),
    certificate.toString(),
  );
  for (const time of [from - 1, to + 1, NaN, Infinity, "2026-10-28"])
    assert.throws(() => oracleReadCACertificate(fixture, { now: time }));
  // Turn this public fixture's basicConstraints cA TRUE into FALSE. This is
  // intentionally not a signed/usable replacement certificate or new credential;
  // it only exercises X509Certificate.ca rejection without generating a key.
  const der = Buffer.from(certificate.raw);
  const constraint = Buffer.from("0603551d130101ff040530030101ff", "hex");
  const position = der.indexOf(constraint);
  assert.notEqual(position, -1);
  der[position + constraint.length - 1] = 0;
  assert.equal(new X509Certificate(der).ca, false);
  assert.throws(() => oracleReadCACertificate(pem(der), { now }));
});

test("Oracle config keeps optional canonical CA outside driver options", () => {
  const plain = oracleReadInput(input());
  assert.equal(plain.caCertificatePem, undefined);
  const configured = oracleReadInput(
    input({ caCertificatePem: fixture.replaceAll("\n", "\r\n") }),
  );
  assert.equal(configured.caCertificatePem, certificate.toString());
  assert.deepEqual(configured.connectionOptions, plain.connectionOptions);
  assert.equal(
    Object.hasOwn(configured.connectionOptions, "caCertificatePem"),
    false,
  );
  for (const value of [undefined, null])
    assert.throws(() => oracleReadInput(input({ caCertificatePem: value })));
  assert.throws(() =>
    oracleReadInput(input({ ssl: false, caCertificatePem: fixture })),
  );
  assert.throws(() => oracleReadInput(input({ ca: fixture })));
});

test("Oracle config counts canonical CA in its aggregate 128 KiB budget", () => {
  const nearLimit = input({ password: "\n".repeat(65000) });
  assert.doesNotThrow(() => oracleReadInput(nearLimit));
  assert.throws(
    () => oracleReadInput({ ...nearLimit, caCertificatePem: fixture }),
    /128 KiB/,
  );
});
