import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
test(
  "PostgreSQL read/write clients isolate explicit identities and startup configuration from ambient credentials",
  { timeout: 20000 },
  async () => {
    const child = spawn(
      process.execPath,
      ["tests/fixtures/postgres-explicit-probe.mjs"],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        env: {
          ...(process.platform === "win32"
            ? { SystemRoot: process.env.SystemRoot }
            : {}),
          PGUSER: "ambient-user",
          PGDATABASE: "ambient-database",
          PGPASSWORD: "ambient-env-password",
          PGHOST: "ambient.invalid",
          PGPORT: "65432",
          PGSSLMODE: "no-verify",
          PGOPTIONS: "-c search_path=ambient",
          PGAPPNAME: "ambient-app",
          PGREPLICATION: "database",
          PGCLIENT_ENCODING: "SQL_ASCII",
          PGBINARY: "1",
          PGPASSFILE: "/never-read-by-this-fixture",
          HOME: "/never-read-by-this-fixture",
          NODE_PG_FORCE_NATIVE: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    const timer = setTimeout(() => child.kill(), 15000);
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    }).finally(() => clearTimeout(timer));
    assert.equal(code, 0, stdout + stderr);
    assert.match(stdout, /EXPLICIT_PG_IDENTITY_WIRE_NO_AMBIENT_NO_PGPASS_PASS/);
  },
);
