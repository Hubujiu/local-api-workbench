import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSessions } from "../src/database-sessions.mjs";

test("DM8 real verified TLS, exact decimal, bind order and binary read", async (t) => {
  if (
    !process.env.LOCALAPI_DAMENG_REAL ||
    process.env.LOCALAPI_DAMENG_REAL === "0"
  )
    return t.skip("DM8 real service is not configured");
  assert.equal(process.env.LOCALAPI_DAMENG_REAL, "1");
  const config = JSON.parse(
    await readFile(process.env.LOCALAPI_DAMENG_REAL_CONFIG, "utf8"),
  );
  const sessions = new DatabaseSessions();
  try {
    const { id } = sessions.register("real-fixture", {
      ...config,
      type: "dameng",
      name: "DM8 read fixture",
      relations: ["WORKBENCH.READ_FIXTURE"],
    });
    const result = await sessions.query("real-fixture", {
      connectionId: id,
      sql: "SELECT id, amount, payload FROM WORKBENCH.READ_FIXTURE WHERE id>=:p1 AND id<=:p0 ORDER BY id",
      parameters: [1, 1],
    });
    assert.deepEqual(result.rows, [
      {
        ID: "1",
        AMOUNT: "12345678901234567890.125",
        PAYLOAD: { type: "blob", base64: "AAH/" },
      },
    ]);
  } catch {
    assert.fail("DM8 real-service read or exact-value comparison failed");
  } finally {
    sessions.close();
  }
});
