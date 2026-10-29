// CI-only real application/transport workflows. Never part of local pure checks.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import {
  importIntoProject,
  normalizeRequest,
  snapshotPlan,
  toCurl,
} from "../src/core.mjs";
const exec = promisify(execFile);
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
async function bytes(directory) {
  const result = {};
  async function visit(dir, prefix = "") {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory())
        await visit(path.join(dir, entry.name), name + "/");
      else
        result[name] = (await readFile(path.join(dir, entry.name))).toString(
          "base64",
        );
    }
  }
  await visit(directory);
  return result;
}
function document(base, tag) {
  return {
    info: { name: "Same source " + tag, _postman_id: "same-source-id" },
    variable: [
      { key: "base", value: base },
      { key: "scope", value: tag },
      { key: "shadow", value: tag + "-shadow" },
      { key: "zero", value: 0, type: "number" },
      { key: "bool", value: false },
      { key: "nil", value: null },
      { key: "empty", value: "" },
      { key: "counter", value: 0 },
      { key: "object", value: { nested: [0] } },
    ],
    event: [
      {
        listen: "prerequest",
        script: { exec: ["pm.collectionVariables.set('trace','C');"] },
      },
    ],
    item: [
      {
        name: "folder",
        event: [
          {
            listen: "prerequest",
            script: {
              exec: [
                "pm.collectionVariables.set('trace',pm.collectionVariables.get('trace')+'F');",
              ],
            },
          },
        ],
        item: [
          {
            name: tag,
            request: {
              method: "GET",
              url: {
                raw:
                  base +
                  "/" +
                  tag +
                  "?scope={{scope}}&shadow={{shadow}}&trace={{trace}}&zero={{zero}}&bool={{bool}}&nil={{nil}}&empty={{empty}}",
              },
            },
            event: [
              {
                listen: "prerequest",
                script: {
                  exec: [
                    `pm.test('collection/environment isolation',()=>{if(pm.collectionVariables.get('shadow')!=='${tag}-shadow'||!pm.variables.get('shadow').startsWith('ENV'))throw Error('scope mismatch');});`,
                    "const collectionCopy=pm.collectionVariables.get('object');collectionCopy.nested.push(99);if(pm.collectionVariables.get('object').nested.length!==1)throw Error('get leaked');",
                    "pm.collectionVariables.set('scratch',false);if(!pm.collectionVariables.has('scratch')||pm.collectionVariables.get('scratch')!==false)throw Error('false lost');pm.collectionVariables.unset('scratch');",
                    "const savedCollection=pm.collectionVariables.toObject();pm.collectionVariables.clear();if(Object.keys(pm.collectionVariables.toObject()).length)throw Error('clear failed');for(const [key,value]of Object.entries(savedCollection))pm.collectionVariables.set(key,value);",
                    "pm.collectionVariables.set('trace',pm.collectionVariables.get('trace')+'R');pm.collectionVariables.set('counter',pm.collectionVariables.get('counter')+1);",
                    `if(pm.collectionVariables.replaceIn('{{scope}}/{{zero}}')!=='${tag}/0')throw Error('replaceIn wrong layer');`,
                  ],
                },
              },
              {
                listen: "test",
                script: {
                  exec: [
                    "pm.collectionVariables.set('last',pm.response.json().path);pm.test('received scope',()=>{if(pm.response.json().query.scope!==pm.collectionVariables.get('scope'))throw Error('wrong wire');});",
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}
for (const mode of ["http", "stdio"])
  test(
    `Postman collections owner import -> ${mode} SDK A/B/A -> cURL -> backup/restart/CLI retains scope identity and evidence`,
    { timeout: 30000 },
    async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), "postman-collections-")),
        seen = [],
        clients = [];
      const wire = http.createServer((req, res) => {
        const url = new URL(req.url, "http://local");
        const value = {
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
        };
        seen.push(value);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(value));
      });
      await new Promise((resolve) => wire.listen(0, "127.0.0.1", resolve));
      let app = await createApp({ root, port: 0 });
      t.after(async () => {
        await Promise.all(clients.map((c) => c.close().catch(() => {})));
        app.server.closeAllConnections();
        wire.closeAllConnections();
        await Promise.all(
          [app.server, wire].map((s) => new Promise((r) => s.close(r))),
        );
        await rm(root, { recursive: true, force: true });
      });
      const owner = async (route, method = "GET", body, status = 200) => {
        const response = await fetch(app.url + route, {
          method,
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const value = await response.json();
        assert.equal(response.status, status, JSON.stringify(value));
        return value;
      };
      const created = await app.store.create("Collection workflow"),
        other = await app.store.create("No grant");
      const envId = created.environments[0].id;
      created.environments[0].variables = { shadow: "ENV1" };
      created.environments.push({
        id: "env2",
        name: "Second",
        variables: { shadow: "ENV2" },
      });
      created.globalVariables = { scope: "GLOBAL", shadow: "GLOBAL" };
      await app.store.save(created);
      const base = "http://127.0.0.1:" + wire.address().port;
      for (const tag of ["A", "B"])
        await owner(`/api/projects/${created.id}/import`, "POST", {
          document: document(base, tag),
          postmanVariableMode: "collection",
        });
      let p = await app.store.get(created.id);
      assert.equal(p.environments.length, 2);
      assert.equal(p.postmanCollections.items.length, 2);
      const [a, b] = p.requests,
        [ca, cb] = p.postmanCollections.items;
      assert.notEqual(ca.id, cb.id);
      assert.equal(a.postmanCollectionId, ca.id);
      assert.equal(b.postmanCollectionId, cb.id);
      const legacy = await app.store.create("Legacy unchanged");
      await owner(`/api/projects/${legacy.id}/import`, "POST", {
        document: document(base, "Legacy"),
      });
      const old = await app.store.get(legacy.id);
      assert.equal(old.postmanCollections, undefined);
      assert.equal(old.environments.length, 2);
      const unbound = normalizeRequest({ url: base + "/legacy" });
      assert.equal(Object.hasOwn(unbound, "postmanCollectionId"), false);
      const oldFrozen = snapshotPlan({ steps: [{ request: unbound }] });
      assert.equal(
        Object.hasOwn(oldFrozen.steps[0].request, "postmanCollectionId"),
        false,
      );
      const before = await bytes(app.store.directory(p.id)),
        invalid = document(base, "invalid");
      invalid.variable.push({ key: "missing-value" });
      await owner(
        `/api/projects/${p.id}/import`,
        "POST",
        { document: invalid, postmanVariableMode: "collection" },
        400,
      );
      assert.deepEqual(await bytes(app.store.directory(p.id)), before);
      const direct = structuredClone(p),
        directBefore = structuredClone(direct);
      assert.throws(
        () =>
          importIntoProject(direct, invalid, {
            postmanVariableMode: "collection",
          }),
        /value/,
      );
      assert.deepEqual(direct, directBefore);
      await owner(
        `/api/projects/${p.id}/export?format=openapi`,
        "GET",
        undefined,
        400,
      );
      await owner(
        `/api/projects/${p.id}/load`,
        "POST",
        { request: a, count: 1 },
        400,
      );
      assert.deepEqual(await bytes(app.store.directory(p.id)), before);
      assert.equal(seen.length, 0);
      assert.throws(() => toCurl(a), /项目上下文/);
      const curl = await owner(`/api/projects/${p.id}/curl`, "POST", {
        request: {
          ...a,
          beforeScript: "",
          afterScript: "",
          url: base + "/curl?scope={{scope}}&shadow={{shadow}}",
        },
        environmentId: "env2",
      });
      const wireCurl = await exec("curl", [...parseCurl(curl.curl)], {
        timeout: 5000,
      });
      assert.deepEqual(JSON.parse(wireCurl.stdout).query, {
        scope: "A",
        shadow: "ENV2",
      });
      const own = await owner(`/api/projects/${p.id}/execute`, "POST", {
        request: a,
        environmentId: envId,
      });
      assert.equal(own.outcome, "passed");
      assert.equal(own.variableWrites.commits, 2);
      assert.deepEqual(JSON.parse(own.body).query, {
        scope: "A",
        shadow: "ENV1",
        trace: "CFR",
        zero: "0",
        bool: "false",
        nil: "null",
        empty: "",
      });
      const debugRoute = `/api/projects/${p.id}/debug-variables?environmentId=${envId}&postmanCollectionId=${ca.id}`;
      const debugA = await owner(debugRoute);
      assert.equal(debugA.postmanCollectionId, ca.id);
      await owner(`/api/projects/${p.id}/debug-variables`, "PUT", {
        ...debugA,
        variables: { ...debugA.variables, shadow: "debug-A" },
      });
      const debugB = await owner(
        `/api/projects/${p.id}/debug-variables?environmentId=${envId}&postmanCollectionId=${cb.id}`,
      );
      assert.equal(debugB.variables.shadow, "ENV1");
      const debugRun = await owner(`/api/projects/${p.id}/execute`, "POST", {
        request: {
          ...a,
          beforeScript: "",
          afterScript: "",
          url: base + "/debug?scope={{scope}}&shadow={{shadow}}",
        },
        environmentId: envId,
      });
      assert.equal(JSON.parse(debugRun.body).query.shadow, "debug-A");
      let edited = await app.store.get(p.id);
      edited.postmanCollections.items[0].variables.shadow = "shadowed-change";
      await app.store.save(edited);
      assert.equal((await owner(debugRoute)).variables.shadow, "ENV1");
      edited = await app.store.get(p.id);
      edited.postmanCollections.items[0].variables.shadow = "A-shadow";
      await app.store.save(edited);
      const config = await owner("/api/mcp/config", "POST", {
        enabled: true,
        projects: [p.id],
        write: true,
        execute: true,
      });
      const client = new Client({ name: "collection-" + mode, version: "1" });
      clients.push(client);
      await client.connect(
        mode === "http"
          ? new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
              requestInit: {
                headers: { Authorization: "Bearer " + config.token },
              },
            })
          : new StdioClientTransport({
              command: process.execPath,
              args: [
                fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
                "--project",
                p.id,
                "--write",
                "--execute",
              ],
              env: { LOCAL_API_DATA: root },
              stderr: "pipe",
            }),
      );
      assert(
        (await client.listTools()).tools.some(
          (tool) => tool.name === "localapi_execute_flow",
        ),
      );
      const call = (name, args) =>
        client.callTool({ name, arguments: { projectId: p.id, ...args } });
      const denied = await client.callTool({
        name: "localapi_list_apis",
        arguments: { projectId: other.id },
      });
      assert.equal(denied.isError, true);
      const api = decode(
        await call("localapi_execute_api", {
          apiId: b.id,
          environmentId: "env2",
        }),
      );
      assert.equal(api.status, "passed");
      assert.equal(api.recordSaved, true);
      const plan = decode(
        await call("localapi_create_execution_flow", {
          plan: {
            id: "mixed",
            name: "A B A",
            environmentId: envId,
            statusPolicy: "strict200",
            steps: [
              { id: "a1", request: a },
              { id: "b1", request: b },
              { id: "a2", request: a },
            ],
          },
        }),
      );
      const run = decode(
        await call("localapi_execute_flow", { planId: plan.id }),
      );
      assert.equal(run.status, "passed");
      assert.equal(run.recordSaved, true);
      assert.deepEqual(
        run.results.map((r) => JSON.parse(r.response.body).query.scope),
        ["A", "B", "A"],
      );
      p = await app.store.get(p.id);
      assert.equal(p.postmanCollections.items[0].variables.counter, 3);
      assert.equal(p.postmanCollections.items[1].variables.counter, 2);
      const detail = decode(
        await call("localapi_get_execution_result", { runId: run.id }),
      );
      assert.equal(detail.planHash, run.planHash);
      assert.deepEqual(detail.snapshot, run.snapshot);
      p.requests[0] = {
        ...p.requests[0],
        url: base + "/live-rebound",
        postmanCollectionId: cb.id,
      };
      await app.store.save(p);
      const frozen = decode(
        await call("localapi_execute_flow", { planId: plan.id }),
      );
      assert.equal(frozen.planHash, run.planHash);
      assert.equal(frozen.snapshot.steps[0].request.postmanCollectionId, ca.id);
      assert.deepEqual(
        frozen.results.map((r) => JSON.parse(r.response.body).path),
        ["/A", "/B", "/A"],
      );
      const backup = await owner(`/api/projects/${p.id}/export`),
        restored = await owner(
          "/api/restore",
          "POST",
          { document: backup },
          201,
        );
      assert.notEqual(restored.id, p.id);
      assert.deepEqual(restored.postmanCollections, backup.postmanCollections);
      assert.deepEqual(restored.plans, backup.plans);
      const forged = structuredClone(backup);
      forged.postmanCollections.items = [];
      await owner("/api/restore", "POST", { document: forged }, 400);
      assert.equal(
        (
          await client.callTool({
            name: "localapi_list_apis",
            arguments: { projectId: restored.id },
          })
        ).isError,
        true,
      );
      await client.close();
      const count = seen.length;
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
      app = await createApp({ root, port: 0 });
      assert.equal(seen.length, count);
      const recovered = await owner(`/api/projects/${restored.id}`);
      assert.deepEqual(recovered.postmanCollections, backup.postmanCollections);
      assert.deepEqual(recovered.runs, backup.runs);
      const sourceBytes = await bytes(app.store.directory(p.id));
      const cli = await exec(
        process.execPath,
        [
          fileURLToPath(new URL("../scripts/run-plan.mjs", import.meta.url)),
          "--project",
          restored.id,
          "--plan",
          plan.id,
        ],
        { env: { ...process.env, LOCAL_API_DATA: root }, timeout: 10000 },
      );
      const cliRun = JSON.parse(cli.stdout);
      assert.equal(cliRun.status, "passed");
      assert.equal(cliRun.recordSaved, true);
      assert.equal(cliRun.planHash, run.planHash);
      assert.deepEqual(
        cliRun.results.map((r) => JSON.parse(r.response.body).query.scope),
        ["A", "B", "A"],
      );
      assert.deepEqual(await bytes(app.store.directory(p.id)), sourceBytes);
      assert.equal(
        (await app.store.get(restored.id)).postmanCollections.items[0].variables
          .counter,
        backup.postmanCollections.items[0].variables.counter + 2,
      );
    },
  );
// Parse only our own exporter output; never run shell expansion or a shell.
function parseCurl(command) {
  const tokens = [];
  let value = "",
    quoted = false,
    active = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'") {
      quoted = !quoted;
      active = true;
      continue;
    }
    if (!quoted && c === "\\") {
      value += command[++i];
      active = true;
      continue;
    }
    if (!quoted && /\s/.test(c)) {
      if (active) {
        tokens.push(value);
        value = "";
        active = false;
      }
    } else {
      value += c;
      active = true;
    }
  }
  if (active) tokens.push(value);
  assert.equal(quoted, false);
  assert.equal(tokens.shift(), "curl");
  return tokens;
}

test(
  "collection stage exceptions, host identity forgery and concurrent same-field edits preserve evidence without partial writes",
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "collection-stage-errors-")),
      seen = [];
    const arrived = Promise.withResolvers(),
      release = Promise.withResolvers();
    let pending;
    const wire = http.createServer(async (req, res) => {
      seen.push(req.url);
      if (req.url === "/held") {
        arrived.resolve();
        await release.promise;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ path: req.url }));
    });
    await new Promise((r) => wire.listen(0, "127.0.0.1", r));
    const app = await createApp({ root, port: 0 });
    t.after(async () => {
      release.resolve();
      await pending?.catch(() => {});
      app.server.closeAllConnections();
      wire.closeAllConnections();
      await Promise.all(
        [app.server, wire].map((s) => new Promise((r) => s.close(r))),
      );
      await rm(root, { recursive: true, force: true });
    });
    const owner = async (route, method = "GET", body, status = 200) => {
      const r = await fetch(app.url + route, {
        method,
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await r.json();
      assert.equal(r.status, status, JSON.stringify(value));
      return value;
    };
    const p = await app.store.create("Stages"),
      base = "http://127.0.0.1:" + wire.address().port;
    const imported = await owner(`/api/projects/${p.id}/import`, "POST", {
      postmanVariableMode: "collection",
      document: {
        info: { name: "Stage collection" },
        variable: [{ key: "stage", value: "old" }],
        item: [{ name: "request", request: { url: { raw: base + "/main" } } }],
      },
    });
    const bound = imported.requests[0],
      read = () => app.store.get(p.id),
      values = async () => (await read()).postmanCollections.items[0].variables;
    const execute = (request) =>
      owner(`/api/projects/${p.id}/execute`, "POST", {
        request,
        environmentId: p.environments[0].id,
      });
    const original = await read();
    const failedPre = await execute({
      ...bound,
      beforeScript:
        "pm.collectionVariables.set('stage','pre-rejected');throw Error('pre failed');",
    });
    assert.equal(failedPre.outcome, "failed");
    assert.match(failedPre.error, /pre failed/);
    assert.equal((await values()).stage, "old");
    assert.equal(seen.length, 0);
    assert.equal((await read()).configRevision, original.configRevision);
    const failedPost = await execute({
      ...bound,
      beforeScript: "pm.collectionVariables.set('stage','pre-committed');",
      afterScript:
        "pm.collectionVariables.set('stage','post-rejected');throw Error('post failed');",
    });
    assert.equal(failedPost.outcome, "failed");
    assert.equal(failedPost.status, 200);
    assert.match(failedPost.error, /post failed/);
    assert.equal((await values()).stage, "pre-committed");
    assert.equal(failedPost.variableWrites.commits, 1);
    const forged = await execute({
      ...bound,
      beforeScript:
        "pm.collectionVariables.set('stage','forged');request.postmanCollectionId='other-collection';",
    });
    assert.equal(forged.outcome, "failed");
    assert.match(forged.error, /宿主固定/);
    assert.equal((await values()).stage, "pre-committed");
    assert.deepEqual(seen, ["/main"]);
    const beforeMissing = await bytes(app.store.directory(p.id));
    await owner(
      `/api/projects/${p.id}/execute`,
      "POST",
      { request: { ...bound, postmanCollectionId: "missing" } },
      400,
    );
    assert.deepEqual(await bytes(app.store.directory(p.id)), beforeMissing);
    pending = execute({
      ...bound,
      url: base + "/held",
      afterScript: "pm.collectionVariables.set('stage','would-overwrite');",
    });
    await arrived.promise;
    const external = await read();
    external.postmanCollections.items[0].variables.stage = "external";
    external.description = "unrelated edit kept";
    await app.store.save(external);
    release.resolve();
    const conflict = await pending;
    assert.equal(conflict.outcome, "failed");
    assert.equal(conflict.status, 200);
    assert.match(conflict.error, /变量冲突/);
    assert.equal(conflict.variableWrites.commits, 0);
    const saved = await read();
    assert.equal(saved.postmanCollections.items[0].variables.stage, "external");
    assert.equal(saved.description, "unrelated edit kept");
    assert.equal(saved.history.length, 4);
    assert.deepEqual(seen, ["/main", "/held"]);
    const invalidPlan = {
      id: "bad",
      name: "bad",
      steps: [{ request: { ...bound, postmanCollectionId: "missing" } }],
    };
    const beforeInvalid = await bytes(app.store.directory(p.id));
    await owner(`/api/projects/${p.id}/plans`, "POST", invalidPlan, 400);
    assert.deepEqual(await bytes(app.store.directory(p.id)), beforeInvalid);
  },
);

test(
  "collection reference retirement rejects live/case/disabled-plan loss, retains historical evidence through backup restart and rejects unsupported SDK modes",
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "collection-retirement-")),
      seen = [],
      clients = [];
    const wire = http.createServer((req, res) => {
      seen.push(req.url);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ url: req.url }));
    });
    await new Promise((resolve) => wire.listen(0, "127.0.0.1", resolve));
    let app = await createApp({ root, port: 0 });
    t.after(async () => {
      await Promise.all(
        clients.map((client) => client.close().catch(() => {})),
      );
      app.server.closeAllConnections();
      wire.closeAllConnections();
      await Promise.all(
        [app.server, wire].map(
          (server) => new Promise((resolve) => server.close(resolve)),
        ),
      );
      await rm(root, { recursive: true, force: true });
    });
    const owner = async (route, method = "GET", body, status = 200) => {
      const response = await fetch(app.url + route, {
        method,
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await response.json();
      assert.equal(response.status, status, JSON.stringify(value));
      return value;
    };
    const p = await app.store.create("Collection retirement"),
      other = await app.store.create("Unrelated project");
    const otherBytes = await bytes(app.store.directory(other.id));
    const source = {
      info: { name: "Retire only after references are removed" },
      variable: [{ key: "value", value: "retained-value" }],
      item: [
        {
          name: "live",
          request: {
            method: "GET",
            url: {
              raw: `http://127.0.0.1:${wire.address().port}/retire?value={{value}}`,
            },
          },
        },
      ],
    };
    const initialBytes = await bytes(app.store.directory(p.id));
    for (const mode of [null, "unsupported"])
      await owner(
        `/api/projects/${p.id}/import`,
        "POST",
        { document: source, postmanVariableMode: mode },
        400,
      );
    assert.deepEqual(await bytes(app.store.directory(p.id)), initialBytes);
    await owner(`/api/projects/${p.id}/import`, "POST", {
      document: source,
      postmanVariableMode: "collection",
    });
    const imported = await owner(`/api/projects/${p.id}`),
      live = imported.requests[0],
      collectionId = live.postmanCollectionId;
    assert.equal(imported.postmanCollections.items[0].id, collectionId);
    const active = await owner(`/api/projects/${p.id}/plans`, "POST", {
      id: "retire-active",
      name: "Historical collection flow",
      environmentId: p.environments[0].id,
      steps: [{ id: "executed", request: live }],
    });
    const run = await owner(`/api/projects/${p.id}/run`, "POST", {
      planId: active.id,
    });
    assert.equal(run.status, "passed");
    assert.equal(run.recordSaved, true);
    // This dependency base acknowledges recordSaved, without root-only recordId.
    assert.equal(typeof run.id, "string");
    assert(run.id.length > 0);
    assert.deepEqual(seen, ["/retire?value=retained-value"]);
    assert.equal(
      run.snapshot.steps[0].request.postmanCollectionId,
      collectionId,
    );
    const savedCase = await owner(`/api/projects/${p.id}/cases`, "POST", {
      id: "retire-case",
      name: "Frozen case",
      sourceRequestId: live.id,
      request: live,
    });
    assert.equal(savedCase.item.request.postmanCollectionId, collectionId);
    const disabled = await owner(`/api/projects/${p.id}/plans`, "POST", {
      id: "retire-disabled",
      name: "Disabled but still a current reference",
      steps: [{ id: "disabled", enabled: false, request: live }],
    });
    assert.equal(disabled.steps[0].enabled, false);
    const all = await owner(`/api/projects/${p.id}`),
      savedRun = structuredClone(all.runs.find((item) => item.id === run.id)),
      allBytes = await bytes(app.store.directory(p.id));
    assert.equal(savedRun.id, run.id);
    assert.equal(savedRun.planHash, run.planHash);
    assert.deepEqual(savedRun.snapshot, run.snapshot);

    // Each rejected candidate has exactly one current reference kind. Other
    // kinds are removed, so one guard cannot accidentally mask the next guard.
    for (const kind of ["live", "case", "disabled-plan"]) {
      const candidate = structuredClone(all);
      delete candidate.requests[0].postmanCollectionId;
      candidate.cases = [];
      candidate.plans = [];
      if (kind === "live")
        candidate.requests[0].postmanCollectionId = collectionId;
      if (kind === "case") candidate.cases = [structuredClone(savedCase.item)];
      if (kind === "disabled-plan")
        candidate.plans = [
          structuredClone(all.plans.find((plan) => plan.id === disabled.id)),
        ];
      delete candidate.postmanCollections;
      const rejected = await owner(
        `/api/projects/${p.id}`,
        "PUT",
        candidate,
        400,
      );
      assert.match(JSON.stringify(rejected), /Postman collection 引用不存在/);
      assert.deepEqual(await owner(`/api/projects/${p.id}`), all);
      assert.deepEqual(await bytes(app.store.directory(p.id)), allBytes);
      assert.deepEqual(seen, ["/retire?value=retained-value"]);
    }

    // Retire live binding and the already executed plan, then the case. The
    // disabled plan is the final current reference and must still block removal.
    let current = await owner(`/api/projects/${p.id}`);
    delete current.requests[0].postmanCollectionId;
    current.plans = current.plans.filter((plan) => plan.id === disabled.id);
    await owner(`/api/projects/${p.id}`, "PUT", current);
    current = await owner(`/api/projects/${p.id}`);
    assert.equal(current.requests[0].postmanCollectionId, undefined);
    assert.equal(current.cases[0].request.postmanCollectionId, collectionId);
    assert.deepEqual(
      current.runs.find((item) => item.id === run.id),
      savedRun,
    );
    current.cases = [];
    await owner(`/api/projects/${p.id}`, "PUT", current);
    current = await owner(`/api/projects/${p.id}`);
    const lastReferenceBytes = await bytes(app.store.directory(p.id)),
      premature = structuredClone(current);
    delete premature.postmanCollections;
    assert.match(
      JSON.stringify(
        await owner(`/api/projects/${p.id}`, "PUT", premature, 400),
      ),
      /Postman collection 引用不存在/,
    );
    assert.deepEqual(
      await bytes(app.store.directory(p.id)),
      lastReferenceBytes,
    );
    current.plans = [];
    delete current.postmanCollections;
    await owner(`/api/projects/${p.id}`, "PUT", current);
    const retired = await owner(`/api/projects/${p.id}`);
    assert.equal(Object.hasOwn(retired, "postmanCollections"), false);
    assert.deepEqual(retired.plans, []);
    assert.deepEqual(retired.cases, []);
    assert.deepEqual(
      retired.runs.find((item) => item.id === run.id),
      savedRun,
    );
    const retiredBytes = await bytes(app.store.directory(p.id));
    // Reading old evidence is allowed; it is not an implicit grant to revive an
    // executable definition with a collection that no longer exists.
    const revived = await owner(
      `/api/projects/${p.id}/plans`,
      "POST",
      run.snapshot,
      400,
    );
    assert.match(JSON.stringify(revived), /Postman collection 引用不存在/);
    assert.deepEqual(await bytes(app.store.directory(p.id)), retiredBytes);
    const backup = await owner(`/api/projects/${p.id}/export`),
      restored = await owner("/api/restore", "POST", { document: backup }, 201);
    assert.notEqual(restored.id, p.id);
    assert.equal(Object.hasOwn(restored, "postmanCollections"), false);
    assert.deepEqual(
      restored.runs.find((item) => item.id === run.id),
      savedRun,
    );
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    app = await createApp({ root, port: 0 });
    const recovered = await owner(`/api/projects/${restored.id}`);
    assert.equal(Object.hasOwn(recovered, "postmanCollections"), false);
    assert.deepEqual(
      recovered.runs.find((item) => item.id === run.id),
      savedRun,
    );
    assert.deepEqual(seen, ["/retire?value=retained-value"]);
    const restoredBytes = await bytes(app.store.directory(restored.id));
    for (const mode of ["http", "stdio"]) {
      const client = new Client(
        { name: "collection-retirement-" + mode, version: "1" },
        { capabilities: {} },
      );
      clients.push(client);
      let transport;
      if (mode === "http") {
        const config = await owner("/api/mcp/config", "POST", {
          enabled: true,
          projects: [restored.id],
          write: true,
          execute: false,
          remember: false,
        });
        transport = new StreamableHTTPClientTransport(
          new URL(app.url + "/mcp"),
          {
            requestInit: {
              headers: { Authorization: "Bearer " + config.token },
            },
          },
        );
      } else {
        transport = new StdioClientTransport({
          command: process.execPath,
          args: [
            fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
            "--project",
            restored.id,
            "--write",
          ],
          env: { LOCAL_API_DATA: root },
          stderr: "pipe",
        });
        transport.stderr.resume();
      }
      await client.connect(transport);
      const tools = (await client.listTools()).tools;
      assert(tools.some((tool) => tool.name === "localapi_sync_openapi"));
      assert(
        tools.some((tool) => tool.name === "localapi_get_execution_result"),
      );
      assert(!tools.some((tool) => tool.name === "localapi_execute_flow"));
      const call = (name, args) =>
        client.callTool({
          name,
          arguments: { projectId: restored.id, ...args },
        });
      const detail = decode(
        await call("localapi_get_execution_result", { runId: run.id }),
      );
      assert.deepEqual(detail, savedRun);
      assert.equal(detail.planHash, run.planHash);
      assert.deepEqual(detail.snapshot, run.snapshot);
      for (const unsupportedMode of ["collection", "unsupported"]) {
        const rejected = await call("localapi_sync_openapi", {
          document: {
            openapi: "3.0.3",
            info: { title: "Would otherwise import", version: "1" },
            paths: {
              "/must-not-import": {
                get: { responses: { 200: { description: "OK" } } },
              },
            },
          },
          postmanVariableMode: unsupportedMode,
        });
        assert.equal(rejected.isError, true);
        assert.match(rejected.content[0].text, /未知参数 postmanVariableMode/);
        assert.deepEqual(
          await bytes(app.store.directory(restored.id)),
          restoredBytes,
        );
      }
      const denied = await client.callTool({
        name: "localapi_get_execution_result",
        arguments: { projectId: p.id, runId: run.id },
      });
      assert.equal(denied.isError, true);
      await client.close();
    }
    assert.deepEqual(await bytes(app.store.directory(p.id)), retiredBytes);
    assert.deepEqual(await bytes(app.store.directory(other.id)), otherBytes);
    assert.deepEqual(
      await bytes(app.store.directory(restored.id)),
      restoredBytes,
    );
    assert.deepEqual(
      seen,
      ["/retire?value=retained-value"],
      "retirement, history reads and restart never replay the old request",
    );
  },
);
