import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createScopes,
  effectiveScopes,
  applyLegacyVariables,
  scopeChanges,
  projectScopes,
  persistScopeChanges,
} from "../src/variable-scopes.mjs";
import { Store } from "../src/runtime.mjs";
test("scope precedence, runtime deletion and explicit false/null values remain distinct", () => {
  const state = createScopes(
    {},
    {
      globals: { same: "global", g: null },
      environment: { same: "env", flag: false },
      runtime: { same: "runtime" },
    },
  );
  assert.equal(effectiveScopes(state).same, "runtime");
  assert.equal(effectiveScopes(state).flag, false);
  assert.equal(effectiveScopes(state).g, null);
  const before = effectiveScopes(state),
    after = { ...before };
  delete after.same;
  applyLegacyVariables(state, before, after);
  assert.equal(Object.hasOwn(effectiveScopes(state), "same"), false);
  state.environment.same = "new";
  assert.equal(Object.hasOwn(effectiveScopes(state), "same"), false);
  applyLegacyVariables(state, effectiveScopes(state), {
    ...effectiveScopes(state),
    same: 0,
  });
  assert.equal(effectiveScopes(state).same, 0);
});
test("field-level scope persistence keeps unrelated edits and rejects same-variable conflicts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "api-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root),
    project = await store.create("scopes"),
    envId = project.environments[0].id;
  const before = projectScopes(project, envId),
    after = createScopes({}, before);
  after.environment.token = "saved";
  after.globals.globalFlag = false;
  const unrelated = await store.get(project.id);
  unrelated.name = "other edit";
  await store.save(unrelated);
  await persistScopeChanges(
    store,
    project.id,
    envId,
    scopeChanges(before, after),
  );
  const saved = await store.get(project.id);
  assert.equal(saved.name, "other edit");
  assert.equal(saved.environments[0].variables.token, "saved");
  assert.equal(saved.globalVariables.globalFlag, false);
  const base = projectScopes(saved, envId),
    changed = createScopes({}, base);
  changed.environment.token = "mine";
  const concurrent = await store.get(project.id);
  concurrent.environments[0].variables.token = "theirs";
  await store.save(concurrent);
  await assert.rejects(
    persistScopeChanges(store, project.id, envId, scopeChanges(base, changed)),
    /变量冲突/,
  );
  assert.equal(
    (await store.get(project.id)).environments[0].variables.token,
    "theirs",
  );
  const restart = new Store(root);
  assert.equal(
    (await restart.get(project.id)).globalVariables.globalFlag,
    false,
  );
});
test("debug effective values become runtime deltas, not copies that mask later scope changes", () => {
  const project = {
    environments: [{ id: "env", variables: { env: 1, shared: "env" } }],
    globalVariables: { shared: "global", global: 2 },
  };
  const state = projectScopes(project, "env", {
    env: 1,
    shared: "env",
    global: 2,
    runtime: 3,
  });
  assert.deepEqual(Object.keys(state.runtime), ["runtime"]);
  state.environment.shared = "changed";
  assert.equal(effectiveScopes(state).shared, "changed");
});

test("script scoped APIs keep environment/global maps separate and report no half-write on errors", async () => {
  const { runScript } = await import("../src/scripts.mjs");
  const result = await runScript(
    'pm.globals.set("same","new-global"); pm.environment.set("same","new-env"); apt.variables.set("flag",false); apt.globals.set("nullable",null); pm.test("scope",()=>pm.expect(pm.globals.get("same")).to.equal("new-global"));',
    {
      variables: {},
      scopes: { globals: { same: "g" }, environment: { same: "e" } },
    },
  );
  assert.equal(result.variables.same, "new-env");
  assert.equal(result.scopes.globals.same, "new-global");
  assert.equal(result.scopes.environment.flag, false);
  assert.equal(result.scopes.globals.nullable, null);
  assert.equal(result.tests[0].passed, true);
  await assert.rejects(
    runScript('pm.environment.set("secret","partial"); throw Error("stop");', {
      variables: {},
    }),
    /stop/,
  );
  const deleted = await runScript('pm.environment.unset("same");', {
    variables: {},
    scopes: result.scopes,
  });
  assert.equal(deleted.variables.same, "new-global");
});

test("plan commits pre-script scopes before HTTP and retains them when HTTP fails", async () => {
  const { runPlan, snapshotPlan } = await import("../src/core.mjs");
  const events = [];
  const result = await runPlan(
    snapshotPlan({
      steps: [
        {
          request: {
            url: "http://fixture.test/{{token}}",
            beforeScript: 'pm.environment.set("token","ready");',
          },
        },
      ],
    }),
    {},
    async (request) => {
      events.push("http:" + request.url);
      throw Error("network fixture failure");
    },
    {
      variableScopes: createScopes(),
      onScopeChanges: async (changes) => {
        events.push("commit:" + changes[0].after.value);
      },
    },
  );
  assert.deepEqual(events, ["commit:ready", "http:http://fixture.test/ready"]);
  assert.equal(result.status, "failed");
  assert.equal(result.variables.token, "ready");
});
test("extraction destination scopes control post-script visibility and persistence failures preserve response evidence", async () => {
  const { runPlan, snapshotPlan } = await import("../src/core.mjs");
  const commits = [];
  const result = await runPlan(
    snapshotPlan({
      steps: [
        {
          request: {
            url: "http://fixture.test",
            extract: [
              { name: "local", path: "$.value", scope: "local" },
              { name: "saved", path: "$.value", scope: "environment" },
              { name: "shared", path: "$.value", scope: "global" },
            ],
            afterScript:
              'pm.test("local",()=>pm.expect(pm.variables.get("local")).to.equal(42)); pm.test("env",()=>pm.expect(pm.environment.get("saved")).to.equal(42));',
          },
        },
      ],
    }),
    {},
    async () => ({
      status: 200,
      body: '{"value":42}',
      headers: {},
      duration: 1,
    }),
    { onScopeChanges: async (changes) => commits.push(changes) },
  );
  assert.equal(result.status, "passed");
  assert.equal(Object.hasOwn(result.variables, "local"), false);
  assert.equal(result.variables.shared, 42);
  assert.equal(commits[0].length, 2);
  const failed = await runPlan(
    snapshotPlan({
      steps: [
        {
          request: {
            url: "http://fixture.test",
            extract: [{ name: "saved", path: "$.value", scope: "environment" }],
          },
        },
      ],
    }),
    {},
    async () => ({
      status: 200,
      body: '{"value":42}',
      headers: {},
      duration: 1,
    }),
    {
      onScopeChanges: async () => {
        throw Error("变量冲突");
      },
    },
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.results[0].response.status, 200);
  assert.match(failed.results[0].error, /变量持久化失败/);
  assert.equal(Object.hasOwn(failed.variables, "saved"), false);
});

test("UI adopts only its verified scope-write receipt and preserves unrelated unsaved fields", async () => {
  const { adoptVariableWrites } = await import(
    "../public/variable-write-receipt.js"
  );
  const project = {
    configRevision: 2,
    revision: 2,
    environments: [
      { id: "env", variables: { token: "old", draft: "unsaved" } },
    ],
    requests: [{ name: "unsaved request" }],
  };
  const updated = { configRevision: 3, revision: 4, _diskFingerprint: "new" };
  const receipt = {
    baseConfigRevision: 2,
    commits: 1,
    environmentId: "env",
    changes: [
      {
        scope: "environment",
        name: "token",
        before: { exists: true, value: "old" },
        after: { exists: true, value: "new" },
      },
    ],
  };
  assert.equal(adoptVariableWrites(project, updated, receipt), "applied");
  assert.equal(project.environments[0].variables.token, "new");
  assert.equal(project.environments[0].variables.draft, "unsaved");
  assert.equal(project.requests[0].name, "unsaved request");
  const conflict = {
    ...project,
    configRevision: 2,
    environments: [{ id: "env", variables: { token: "local edit" } }],
  };
  assert.equal(adoptVariableWrites(conflict, updated, receipt), "conflict");
  assert.equal(conflict.configRevision, 2);
  assert.equal(conflict.environments[0].variables.token, "local edit");
  assert.equal(
    adoptVariableWrites(
      { ...project, configRevision: 2 },
      { ...updated, configRevision: 5 },
      receipt,
    ),
    "conflict",
  );
});

test("real HTTP debug and MCP execute persist selected environment/global scopes without leaking request locals", async (t) => {
  const { createApp } = await import("../src/server.mjs");
  const { createMCP } = await import("../src/mcp.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "api-scope-http-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("real scopes");
  const envId = project.environments[0].id;
  project.environments.push({ id: "other", name: "other", variables: {} });
  const request = {
    id: "fixture",
    name: "fixture",
    url: app.url + "/mock/" + project.id + "/fixture",
    examples: [{ status: 200, body: '{"id":42}' }],
    afterScript:
      'pm.environment.set("token","saved"); pm.globals.set("shared",0); pm.variables.set("local","ephemeral");',
  };
  project.requests = [request];
  await app.store.save(project);
  const execute = async (request, environmentId = envId) =>
    (
      await fetch(app.url + "/api/projects/" + project.id + "/execute", {
        method: "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ request, environmentId }),
      })
    ).json();
  const result = await execute(request);
  assert.equal(result.outcome, "passed");
  assert.equal(result.variableWrites.commits, 1);
  assert.equal(Object.hasOwn(result.extracted, "local"), false);
  const restarted = await new Store(root).get(project.id);
  assert.equal(restarted.environments[0].variables.token, "saved");
  assert.equal(restarted.globalVariables.shared, 0);
  const other = await execute(
    {
      ...request,
      afterScript:
        'pm.test("isolated",()=>pm.expect(pm.environment.get("token")).to.equal(undefined)); pm.test("shared",()=>pm.expect(pm.globals.get("shared")).to.equal(0));',
    },
    "other",
  );
  assert.equal(other.outcome, "passed");
  const failed = await execute({
    ...request,
    beforeScript:
      'pm.environment.set("bad","partial"); throw Error("stop before send");',
    afterScript: "",
  });
  assert.equal(failed.outcome, "failed");
  assert.equal(
    Object.hasOwn(
      (await app.store.get(project.id)).environments[0].variables,
      "bad",
    ),
    false,
  );
  const mcp = createMCP({
    store: app.store,
    projects: [project.id],
    write: true,
    execute: true,
  });
  const p = await app.store.get(project.id);
  p.requests[0].afterScript = 'apt.globals.set("fromMCP",false);';
  await app.store.save(p);
  const output = await mcp({
    id: 1,
    method: "tools/call",
    params: {
      name: "localapi_execute_api",
      arguments: {
        projectId: project.id,
        apiId: "fixture",
        environmentId: envId,
      },
    },
  });
  assert.equal(output.result.isError, undefined);
  assert.equal(
    (await app.store.get(project.id)).globalVariables.fromMCP,
    false,
  );
});
