import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSessions } from "../src/database-sessions.mjs";
import { MCPDatabaseGrants } from "../src/mcp-database-grants.mjs";

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
  const mcp = new MCPDatabaseGrants(() => ({
    enabled: true,
    write: true,
    execute: true,
    projects: ["real-fixture"],
  }));
  let stage = "register";
  try {
    const grant = {
      ...config,
      type: "dameng",
      name: "DM8 read fixture",
      relations: ["WORKBENCH.READ_FIXTURE"],
    };
    const { id } = sessions.register("real-fixture", grant);
    const operation = (connectionId) => ({
      connectionId,
      sql: "SELECT id, amount, payload FROM WORKBENCH.READ_FIXTURE WHERE id>=:p1 AND id<=:p0 ORDER BY id",
      parameters: [1, 0],
    });
    const select = (id) => sessions.query("real-fixture", operation(id));
    stage = "verified-read";
    const result = await select(id);
    stage = "exact-row";
    assert.deepEqual(result.rows, [
      {
        ID: "1",
        AMOUNT: "12345678901234567890.125",
        PAYLOAD: { type: "blob", base64: "AAH/" },
      },
    ]);
    stage = "revocation";
    sessions.revoke("real-fixture", id);
    await assert.rejects(select(id));
    stage = "mcp-scoped-read";
    const agent = mcp.register({ id: "real-fixture" }, grant);
    const agentRead = () =>
      mcp.query(mcp.capture(), "real-fixture", operation(agent.id));
    await assert.rejects(select(agent.id));
    assert.deepEqual((await agentRead()).rows, result.rows);
    mcp.revoke("real-fixture", agent.id);
    await assert.rejects(agentRead());
    if (process.env.LOCALAPI_DAMENG_REQUIRE_CLIENT_CERT === "1") {
      stage = "client-authentication";
      const { clientCert, clientKey, ...passwordOnly } = grant;
      assert.ok(clientCert && clientKey);
      const missing = sessions.register("real-fixture", passwordOnly);
      await assert.rejects(select(missing.id));
      stage = "untrusted-client-certificate";
      const fixture = (file) =>
        readFile(new URL("./fixtures/" + file, import.meta.url), "utf8");
      const untrusted = sessions.register("real-fixture", {
        ...grant,
        clientCert: await fixture("dameng-client.crt"),
        clientKey: await fixture("localhost.key"),
      });
      await assert.rejects(select(untrusted.id));
      console.log(
        "DM8_MUTUAL_TLS_PASS configured identity requested, missing identity and untrusted certificate refused",
      );
    }
    stage = "wrong-ca";
    const bad = sessions.register("real-fixture", {
      ...grant,
      ca: await readFile(
        new URL("./fixtures/sqlserver-wrong-host.crt", import.meta.url),
        "utf8",
      ),
    });
    await assert.rejects(select(bad.id));
    console.log(
      "DAMENG_REAL_READ_GATE_PASS verified-TLS/bind-order/exact-DECIMAL/binary/owner-and-MCP-revocation/wrong-CA",
    );
  } catch {
    assert.fail("DM8_REAL_GATE_FAILED:" + stage);
  } finally {
    mcp.invalidate();
    sessions.close();
  }
});
