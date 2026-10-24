import test from "node:test";
import assert from "node:assert/strict";
import { snapshotCase } from "../src/cases.mjs";
test("interface cases are independent editable request snapshots linked to their source", () => {
  const input = {
    name: "Wrong password",
    sourceRequestId: "login",
    request: {
      url: "http://localhost/login",
      method: "POST",
      bodyType: "json",
      body: '{"password":"bad"}',
      assertions: [{ target: "status", op: "eq", value: 401 }],
    },
  };
  const first = snapshotCase(input);
  input.request.body = "{}";
  const second = snapshotCase({ ...input, name: "Missing password" });
  assert.notEqual(first.id, second.id);
  assert.equal(first.sourceRequestId, "login");
  assert.equal(first.request.body, '{"password":"bad"}');
  assert.equal(first.request.assertions[0].value, 401);
  assert.throws(
    () => snapshotCase({ name: "", sourceRequestId: "login" }),
    /名称/,
  );
});
