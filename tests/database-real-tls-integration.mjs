// Explicit real-service entrypoint: no skips, mock drivers, or expanded budgets.
import { readFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { queryRemoteDatabase } from "../src/remote-database.mjs";
import { createApp } from "../src/server.mjs";

const types = ["postgres", "mysql", "redis"];
let current = "fixture";
function requireCondition(value) {
  if (!value) throw new Error("REAL_TLS_ASSERTION_FAILED");
}
import { rejectionClass } from "./helpers/database-real-tls-oracle.mjs";

function successful(result) {
  requireCondition(result && JSON.stringify(result.columns) === '["value"]');
  requireCondition(JSON.stringify(result.rows) === '[{"value":"tls-value"}]');
  requireCondition(result.truncated === false);
}
async function negative(input, expected, good, policy) {
  let rejected = false;
  try {
    await queryRemoteDatabase(input);
  } catch (error) {
    rejected = true;
    requireCondition(rejectionClass(error, expected, input.type, policy));
  }
  requireCondition(rejected);
  // A refusal is never accepted as evidence if the fixture stopped serving.
  successful(await queryRemoteDatabase(good));
}

async function main() {
  const fixtureRoot = process.env.LOCALAPI_TLS_ROOT;
  requireCondition(typeof fixtureRoot === "string" && fixtureRoot.length > 0);
  const ca = await readFile(path.join(fixtureRoot, "ca.crt"), "utf8");
  const wrongCA = await readFile(
    path.join(fixtureRoot, "wrong-ca.crt"),
    "utf8",
  );
  const policies = JSON.parse(
    await readFile(path.join(fixtureRoot, "server-policy.json"), "utf8"),
  );
  const ports = JSON.parse(
    await readFile(path.join(fixtureRoot, "ports.json"), "utf8"),
  );
  requireCondition(
    ca.includes("BEGIN CERTIFICATE") &&
      wrongCA.includes("BEGIN CERTIFICATE") &&
      ca !== wrongCA,
  );
  for (const type of types) {
    for (const key of ["good", "bad"])
      requireCondition(
        Number.isInteger(ports[type]?.[key]) &&
          ports[type][key] > 0 &&
          ports[type][key] <= 65535,
      );
    requireCondition(ports[type].good !== ports[type].bad);
  }
  const root = await mkdtemp(path.join(tmpdir(), "database-real-tls-owner-"));
  let app;
  try {
    app = await createApp({ root, port: 0 });
    const project = await app.store.create("Real TLS integration fixture");
    for (const type of types) {
      const good = {
        type,
        host: "127.0.0.1",
        port: ports[type].good,
        user: "tls_reader",
        password: "public-ci-tls-only",
        database: type === "redis" ? 0 : "fixture",
        ssl: true,
        ca,
        ...(type === "redis"
          ? { command: ["GET", "localapi:tls"] }
          : { sql: "SELECT value FROM tls_fixture" }),
      };
      current = `${type}:trusted`;
      successful(await queryRemoteDatabase(good));
      current = `${type}:encrypted-session`;
      if (type === "postgres") {
        const session = await queryRemoteDatabase({
          ...good,
          sql: "SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()",
        });
        requireCondition(JSON.stringify(session.columns) === '["ssl"]');
        requireCondition(
          session.rows.length === 1 && session.rows[0].ssl === true,
        );
      }
      if (type === "mysql") {
        // SHOW is intentionally outside the product's read-only SELECT guard.
        // This independent fixture assertion does not replace product queries.
        const mysql = (await import("mysql2")).default;
        const driver = mysql.createConnection({
          host: good.host,
          port: good.port,
          user: good.user,
          password: good.password,
          database: good.database,
          ssl: { ca, rejectUnauthorized: true, verifyIdentity: true },
          connectTimeout: 3000,
          multipleStatements: false,
        });
        driver.on("error", () => {});
        try {
          const connection = driver.promise();
          await connection.connect();
          const [rows] = await connection.query({
            sql: "SHOW SESSION STATUS LIKE 'Ssl_cipher'",
            timeout: 2000,
          });
          requireCondition(
            rows.length === 1 &&
              typeof rows[0].Value === "string" &&
              rows[0].Value.length > 0,
          );
        } finally {
          driver.destroy();
        }
      }
      current = `${type}:missing-ca`;
      const { ca: omitted, ...withoutCA } = good;
      await negative(withoutCA, "trust", good);
      current = `${type}:wrong-ca`;
      await negative({ ...good, ca: wrongCA }, "trust", good);
      current = `${type}:hostname`;
      await negative({ ...good, port: ports[type].bad }, "hostname", good);
      current = `${type}:plaintext`;
      await negative(
        { ...good, ssl: false },
        "plaintext",
        good,
        policies[type],
      );
      current = `${type}:auth`;
      await negative(
        { ...good, password: "incorrect-public-ci-password" },
        "auth",
        good,
      );
      current = `${type}:owner-http`;
      const response = await fetch(
        `${app.url}/api/projects/${project.id}/database`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-local-token": app.token,
          },
          body: JSON.stringify(good),
        },
      );
      requireCondition(response.status === 200);
      successful(await response.json());
      console.log(`REAL_TLS_${type.toUpperCase()}_PASS`);
    }
  } finally {
    if (app) {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
    }
    await rm(root, { recursive: true, force: true });
  }
  console.log("REAL_TLS_PRODUCT_READS_PASS");
}
main().catch(() => {
  console.error(`REAL_TLS_FAILED:${current}`);
  process.exitCode = 1;
});
