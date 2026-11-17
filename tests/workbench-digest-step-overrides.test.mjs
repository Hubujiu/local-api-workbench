import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/runtime.mjs";
import { normalizeRequest } from "../src/core.mjs";
import { createMCP } from "../src/mcp.mjs";
import { inputAuth } from "../src/native-mcp-plan.mjs";
import { applyMCPInput } from "../src/mcp-request-input.mjs";

const override = (username, password) => ({
  auth: { type: "workbench_digest", workbench_digest: { username, password } },
});
const baseAuth = {
  type: "digest",
  username: "source",
  password: "source-fixture",
  challengePolicy: { algorithm: "MD5", retry: true },
};
test("Workbench Digest extension only patches defined credential fields, preserving challenge policy", () => {
  const base = { auth: baseAuth };
  const input = override("alice", "synthetic-a");
  const before = structuredClone({ base, input });
  assert.deepEqual(applyMCPInput(base, inputAuth(base, input)).auth, {
    ...baseAuth,
    username: "alice",
    password: "synthetic-a",
  });
  assert.deepEqual({ base, input }, before);
  for (const auth of [
    { type: "digest", digest: { username: "alice" } },
    { workbench_digest: { username: "alice" } },
    {
      type: "workbench_digest",
      workbench_digest: { nonce: "not-client-state" },
    },
    {
      type: "workbench_digest",
      workbench_digest: { challengePolicy: { retry: false } },
    },
    { type: "workbench_digest", workbench_digest: { username: 7 } },
  ])
    assert.throws(() => applyMCPInput(base, inputAuth(base, { auth })));
  assert.throws(() =>
    inputAuth({ auth: { type: "basic", username: "x", password: "y" } }, input),
  );
  assert.throws(() =>
    applyMCPInput(
      { auth: { type: "digest", username: "x" } },
      inputAuth({ auth: { type: "digest", username: "x" } }, input),
    ),
  );
});

test(
  "saved repeated Digest steps keep independent credentials through update/reopen and real challenge execution",
  { timeout: 20000 },
  async (t) => {
    const seen = [],
      passwords = { alice: "synthetic-a", bob: "synthetic-b" };
    const md5 = (x) => createHash("md5").update(x).digest("hex");
    const server = http.createServer((req, res) => {
      const header = req.headers.authorization;
      if (!header) {
        seen.push("challenge");
        res.writeHead(401, {
          "www-authenticate":
            'Digest realm="fixture", nonce="fixed", qop="auth", algorithm=MD5',
        });
        res.end();
        return;
      }
      const fields = Object.fromEntries(
        [...header.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map(
          (m) => [m[1], m[2] ?? m[3]],
        ),
      );
      const expected = md5(
        `${md5(`${fields.username}:fixture:${passwords[fields.username]}`)}:fixed:${fields.nc}:${fields.cnonce}:auth:${md5(`GET:${req.url}`)}`,
      );
      const valid =
        header.startsWith("Digest ") &&
        fields.realm === "fixture" &&
        fields.nonce === "fixed" &&
        fields.uri === req.url &&
        fields.qop === "auth" &&
        fields.response === expected;
      seen.push({ username: fields.username, valid });
      res.writeHead(valid ? 200 : 403, { "content-type": "application/json" });
      res.end(JSON.stringify({ user: fields.username, valid }));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const root = await mkdtemp(path.join(tmpdir(), "workbench-digest-steps-"));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await rm(root, { recursive: true, force: true });
    });
    let store = new Store(root);
    await store.init();
    const p = await store.create("Synthetic Digest"),
      other = await store.create("Not granted");
    p.requests = [
      normalizeRequest({
        id: "digest",
        name: "Digest",
        method: "GET",
        url: `http://127.0.0.1:${server.address().port}/fixture`,
        auth: baseAuth,
      }),
    ];
    await store.save(p);
    let dispatch = createMCP({
      store,
      projects: [p.id],
      write: true,
      execute: true,
    });
    const raw = (name, args) =>
      dispatch({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "apipost_" + name, arguments: args },
      });
    const call = async (name, args) => {
      const r = await raw(name, args);
      assert.notEqual(r.result.isError, true, r.result.content[0].text);
      return JSON.parse(r.result.content[0].text);
    };
    const args = {
      project_id: p.id,
      name: "Independent credentials",
      steps: [
        { target_id: "digest", input: override("alice", "synthetic-a") },
        { target_id: "digest", input: override("bob", "synthetic-b") },
      ],
    };
    assert.equal(
      (await raw("create_execution_flow", { ...args, project_id: other.id }))
        .result.isError,
      true,
    );
    const created = await call("create_execution_flow", args);
    const flowArgs = { project_id: p.id, flow_id: created.flow_id };
    let flow = (await call("get_execution_flow", flowArgs)).flow;
    assert.deepEqual(
      flow.steps.map((s) => s.input),
      args.steps.map((s) => s.input),
    );
    // A forbidden challenge-policy edit rejects the entire saved update.
    const invalid = structuredClone(args.steps);
    invalid[0].input.auth.workbench_digest.challengePolicy = { retry: false };
    assert.equal(
      (await raw("update_execution_flow", { ...flowArgs, steps: invalid }))
        .result.isError,
      true,
    );
    assert.deepEqual((await call("get_execution_flow", flowArgs)).flow, flow);
    const discovery = await dispatch({ id: 3, method: "tools/list" });
    assert.match(
      discovery.result.tools.find((tool) => tool.name === "apipost_execute_api")
        .inputSchema.properties.input.properties.auth.description,
      /Workbench扩展/,
    );
    // Edit only step 1; repeat step 2 keeps its own saved override and identity.
    await call("update_execution_flow", {
      ...flowArgs,
      steps: flow.steps.map((s, i) => ({
        target_id: s.target_id,
        step_id: s.step_id,
        ...(i === 0 ? { input: override("alice", "wrong-synthetic") } : {}),
      })),
    });
    p.requests[0].auth.username = "changed-live";
    const latest = await store.get(p.id);
    latest.requests[0].auth = p.requests[0].auth;
    await store.save(latest);
    store = new Store(root);
    await store.init();
    dispatch = createMCP({
      store,
      projects: [p.id],
      write: true,
      execute: true,
    });
    flow = (await call("get_execution_flow", flowArgs)).flow;
    assert.equal(flow.steps[0].api_snapshot.auth.username, "source");
    assert.equal(
      flow.steps[1].input.auth.workbench_digest.password,
      "synthetic-b",
    );
    assert.equal(seen.length, 0);
    const result = await call("execute_flow", flowArgs);
    assert.equal(result.total, 2);
    assert.equal(result.passed, 1);
    assert.equal(result.failed.length, 1);
    assert.deepEqual(seen, [
      "challenge",
      { username: "alice", valid: false },
      "challenge",
      { username: "bob", valid: true },
    ]);
    const evidence = (
      await call("get_execution_result", {
        project_id: p.id,
        run_id: result.run_id,
      })
    ).run;
    assert.deepEqual(
      evidence.results.map((r) => r.response.status),
      [403, 200],
    );
    assert.deepEqual(
      evidence.results.map((r) => r.request.auth.challengePolicy),
      [baseAuth.challengePolicy, baseAuth.challengePolicy],
    );
    const stored = await store.get(p.id);
    assert.equal(stored.requests[0].auth.username, "changed-live");
    const deniedDispatch = createMCP({
      store,
      projects: [p.id],
      write: true,
      execute: false,
    });
    const deniedResult = await deniedDispatch({
      id: 2,
      method: "tools/call",
      params: { name: "apipost_execute_flow", arguments: flowArgs },
    });
    assert.equal(deniedResult.result.isError, true);
    assert.equal(seen.length, 4);
  },
);
