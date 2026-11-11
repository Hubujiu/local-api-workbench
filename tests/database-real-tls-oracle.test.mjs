import test from "node:test";
import assert from "node:assert/strict";
import { rejectionClass } from "./helpers/database-real-tls-oracle.mjs";
const policies = {
  postgres: { ssl: true, hostnosslReject: true },
  mysql: { requireSecureTransport: true },
  redis: { port: 0, tlsPort: 6379 },
};
const pg = {
  code: "28000",
  message:
    'pg_hba.conf rejects connection for host "synthetic", user "fixture", database "fixture", no encryption',
};
const mysql = {
  code: "ER_SECURE_TRANSPORT_REQUIRED",
  errno: 3159,
  message: "Connections using insecure transport are prohibited",
};
test("SQL plaintext requires protocol policy error plus live server configuration evidence", () => {
  assert.equal(
    rejectionClass(pg, "plaintext", "postgres", policies.postgres),
    true,
  );
  assert.equal(
    rejectionClass(mysql, "plaintext", "mysql", policies.mysql),
    true,
  );
  for (const [type, error] of [
    ["postgres", pg],
    ["mysql", mysql],
  ]) {
    assert.equal(rejectionClass(error, "plaintext", type), false);
    assert.equal(
      rejectionClass(
        { ...error, code: "ECONNRESET" },
        "plaintext",
        type,
        policies[type],
      ),
      false,
    );
    assert.equal(rejectionClass(error, "unknown", type, policies[type]), false);
  }
  assert.equal(
    rejectionClass(
      { ...pg, message: "no pg_hba.conf entry; SSL encryption" },
      "plaintext",
      "postgres",
      policies.postgres,
    ),
    false,
  );
  assert.equal(
    rejectionClass(
      { ...mysql, errno: 1045 },
      "plaintext",
      "mysql",
      policies.mysql,
    ),
    false,
  );
});
test("reset, EOF, generic secure-transport wording and auth failures never prove SQL plaintext policy", () => {
  for (const type of ["postgres", "mysql"])
    for (const error of [
      { code: "ECONNRESET", message: "socket closed" },
      { code: "EPIPE" },
      { message: "unexpected end of stream" },
      { message: "secure transport required" },
      { code: "28P01", message: "password authentication failed" },
      { code: "ER_ACCESS_DENIED_ERROR", errno: 1045, message: "access denied" },
      { message: "Redis连接提前关闭" },
    ])
      assert.equal(
        rejectionClass(error, "plaintext", type, policies[type]),
        false,
      );
});
test("Redis closure needs live TLS-only configuration, never timeout or unreachable evidence", () => {
  const closed = { message: "Redis连接提前关闭" };
  assert.equal(
    rejectionClass(closed, "plaintext", "redis", policies.redis),
    true,
  );
  for (const policy of [
    undefined,
    {},
    { port: 6379, tlsPort: 6379 },
    { port: 0, tlsPort: 0 },
  ])
    assert.equal(rejectionClass(closed, "plaintext", "redis", policy), false);
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT"])
    assert.equal(
      rejectionClass(
        { code, message: "socket closed" },
        "plaintext",
        "redis",
        policies.redis,
      ),
      false,
    );
  assert.equal(
    rejectionClass(closed, "plaintext", "unknown", policies.redis),
    false,
  );
});
test("oracle returns booleans only; sensitive diagnostic sentinels are never output", () => {
  const sentinel =
    "PRIVATE_TOKEN_SENTINEL https://private.invalid SECRET_PEM_SENTINEL";
  for (const type of Object.keys(policies))
    assert.equal(
      rejectionClass({ message: sentinel }, "plaintext", type, policies[type]),
      false,
    );
  assert.equal(
    rejectionClass(
      { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE", message: sentinel },
      "trust",
      "postgres",
    ),
    true,
  );
  assert.equal(
    rejectionClass(
      { code: "ERR_TLS_CERT_ALTNAME_INVALID", message: sentinel },
      "hostname",
      "mysql",
    ),
    true,
  );
});
