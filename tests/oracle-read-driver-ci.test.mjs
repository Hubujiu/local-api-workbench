import test from "node:test";
import assert from "node:assert/strict";

// This imports only the OSS client in ordinary GitHub Actions. It never opens a
// connection and is not evidence of database, TLS, or cancellation correctness.
test(
  "CI only: pinned Oracle OSS package loads in default Thin mode without a DB",
  { skip: process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true" },
  async () => {
    const driver = (await import("oracledb")).default;
    assert.equal(driver.versionString, "26.0.0");
    assert.equal(driver.thin, true);
    assert.equal(typeof driver.getConnection, "function");
    for (const name of [
      "STMT_TYPE_SELECT",
      "OUT_FORMAT_ARRAY",
      "BIND_IN",
      "DB_TYPE_NUMBER",
      "DB_TYPE_VARCHAR",
      "DB_TYPE_RAW",
    ])
      assert.notEqual(driver[name], undefined);
  },
);
