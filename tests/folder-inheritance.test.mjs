import test from "node:test";
import assert from "node:assert/strict";
import { applyGlobalParameters } from "../src/global-parameters.mjs";
import { applySharedAuth } from "../src/shared-auth.mjs";
import { applySharedScripts } from "../src/shared-scripts.mjs";
const row = (key, value, enabled = true) => ({ key, value, enabled });
const project = () => ({
  settings: {
    recursiveFolderScopes: true,
    globalParameters: { headers: [row("X-Test", "global")] },
    folderParameters: {
      A: { headers: [row("x-test", "parent"), row("X-Mute", "parent")] },
      "A/B": { headers: [row("X-Mute", "", false)] },
    },
    globalAuth: { type: "bearer", token: "global" },
    folderAuth: {
      A: { type: "bearer", token: "parent" },
      "A/B": { type: "none" },
    },
    globalScripts: { beforeScript: "global()" },
    folderScripts: {
      A: { beforeScript: "parent()" },
      "A/B": { beforeScript: "child()" },
    },
  },
});
test("explicit recursive mode inherits ancestors with nearest overrides and disabled masks", () => {
  const p = project(),
    r = { folder: "A/B/C", headers: [] };
  assert.deepEqual(applyGlobalParameters(p, r).headers, [
    row("x-test", "parent"),
  ]);
  assert.equal(applySharedAuth(p, r).auth.type, "none");
  assert.deepEqual(
    applySharedScripts(p, r).sharedBeforeScripts.map((x) => x.code),
    ["global()", "parent()", "child()"],
  );
  assert.equal(applySharedAuth(p, { folder: "A2/B" }).auth.token, "global");
  assert.deepEqual(
    applyGlobalParameters(p, { ...r, headers: [row("X-Test", "own")] }).headers,
    [row("X-Test", "own")],
  );
});
test("existing projects remain exact-scoped and frozen snapshots never gain ancestors", () => {
  const p = project();
  delete p.settings.recursiveFolderScopes;
  const r = { folder: "A/B/C", headers: [] };
  assert.equal(applySharedAuth(p, r).auth.token, "global");
  assert.deepEqual(
    applySharedScripts(p, r).sharedBeforeScripts.map((x) => x.code),
    ["global()"],
  );
  assert.deepEqual(applyGlobalParameters(p, r).headers, [
    row("X-Test", "global"),
  ]);
  p.settings.recursiveFolderScopes = true;
  assert.deepEqual(
    applyGlobalParameters(p, { ...r, parametersSnapshot: true }).headers,
    [],
  );
  assert.equal(
    applySharedAuth(p, { ...r, authSnapshot: true, auth: { type: "none" } })
      .auth.type,
    "none",
  );
  assert.deepEqual(
    applySharedScripts(p, {
      ...r,
      sharedScriptsSnapshot: true,
      sharedBeforeScripts: [],
    }).sharedBeforeScripts,
    [],
  );
  assert.throws(() =>
    applyGlobalParameters({ settings: { recursiveFolderScopes: "yes" } }, r),
  );
});

import http from "node:http";
import { executeRequest } from "../src/runtime.mjs";
import { normalizeRequest, runPlan, snapshotPlan } from "../src/core.mjs";
import { freezeServiceBinding } from "../src/environments.mjs";
test("recursive scopes reach HTTP in order while snapshots remain frozen", async (t) => {
  let received;
  const server = http.createServer((req, res) => {
    received = req.headers;
    res.end("ok");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const p = project();
  p.settings.globalScripts = { beforeScript: 'apt.setVar("chain","project")' };
  p.settings.folderScripts = {
    A: { beforeScript: 'apt.setVar("chain",apt.getVar("chain")+"-parent")' },
    "A/B": { beforeScript: 'apt.setVar("chain",apt.getVar("chain")+"-child")' },
  };
  const req = normalizeRequest({
    folder: "A/B/C",
    url: `http://127.0.0.1:${server.address().port}`,
    beforeScript: 'apt.setRequestHeader("X-Chain",apt.getVar("chain"))',
  });
  const frozen = freezeServiceBinding(p, req);
  const result = await runPlan(
    snapshotPlan({ steps: [{ request: frozen }] }),
    {},
    executeRequest,
  );
  // Preserve the execution error before inspecting a response that may not exist.
  assert.equal(
    result.status,
    "passed",
    JSON.stringify({ result, requestReached: received !== undefined }),
  );
  assert(received, "a passed plan must have reached the HTTP peer");
  assert.equal(received["x-chain"], "project-parent-child");
  assert.equal(received["x-test"], "parent");
  assert.equal(received["x-mute"], undefined);
});
