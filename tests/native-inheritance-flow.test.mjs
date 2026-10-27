import test from "node:test";
import assert from "node:assert/strict";
import { importIntoProject } from "../src/core.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import { nativeInheritanceFixture } from "./fixtures/native-inheritance.mjs";
import { nativeDirectoryFixture } from "./fixtures/apipost-directory.mjs";
const empty = () => ({
  id: "target",
  name: "Target",
  settings: {},
  requests: [],
  environments: [],
  servers: [],
  folders: [],
  plans: [],
  cases: [],
  caseFolders: [],
});
function fixture(url = "http://127.0.0.1:4318") {
  const source = nativeInheritanceFixture();
  source.global.global_param.auth = { type: "noauth" };
  source.global.envs[0].server_list[0].uri = url;
  source.global.envs[0].env_var_list.selected = {
    value: "default",
    current_value: "default",
  };
  const selected = structuredClone(source.global.envs[0]);
  selected.env_id = "2";
  selected.name = "Selected environment";
  selected.env_var_list.selected = {
    value: "selected",
    current_value: "selected",
  };
  source.global.envs.push(selected);
  source.global.global_param.header.parameter.push({
    key: "X-Environment",
    value: "{{selected}}",
    is_checked: 1,
  });
  const document = nativeDirectoryFixture(source);
  const flow = {
    project_id: source.project_id,
    flow_id: "frozen",
    name: "Independent flow",
    description: "strict HTTP snapshot",
    source: "manual",
    environment_id: "2",
    created_at: "2026-10-27T00:00:00.000Z",
    updated_at: "2026-10-27T00:00:00.000Z",
    steps: ["first", "second"].map((name) => ({
      step_id: name,
      target_id: name,
      api_snapshot: {
        ...structuredClone(source.apis[1]),
        target_id: name,
        project_id: source.project_id,
        name,
        url: "/" + name,
      },
      input: {},
      pre_script: "",
      post_script: "",
    })),
  };
  const { steps, ...meta } = flow;
  document.files.push(
    {
      path: "executions/flows/index.json",
      text: JSON.stringify({
        version: 2,
        updated_at: flow.updated_at,
        records: [{ ...meta, step_count: steps.length }],
      }),
    },
    { path: "executions/flows/frozen.json", text: JSON.stringify(flow) },
  );
  return document;
}
test("preserved graph and independent HTTP flow survive two native directory generations without source mutation", () => {
  const d = fixture(),
    before = structuredClone(d);
  let p = empty();
  importIntoProject(p, d, { inheritanceMode: "preserve" });
  assert.equal(p.plans.length, 1);
  for (let i = 0; i < 2; i++) {
    assert(p.requests[0].nativeInheritance);
    const plan = p.plans[0];
    assert.equal(plan.statusPolicy, "strict200");
    assert.deepEqual(
      plan.steps.map((s) => s.name),
      ["first", "second"],
    );
    assert(
      plan.steps.every(
        (s) =>
          s.request.nativeInheritance === undefined &&
          s.request.authSnapshot &&
          s.request.parametersSnapshot,
      ),
    );
    assert(
      plan.steps.every((s) =>
        s.request.headers.some(
          (h) => h.key === "X-Shared" && h.value === "project",
        ),
      ),
    );
    const saved = structuredClone(p),
      encoded = exportApipostDirectory(p),
      next = empty();
    importIntoProject(next, encoded, { inheritanceMode: "preserve" });
    assert.deepEqual(p, saved);
    p = next;
  }
  assert.deepEqual(d, before);
});

import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { restoreProject } from "../src/core.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
const close = (server) =>
  new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
const decode = (r) => {
  assert.notEqual(r.isError, true, r.content?.[0]?.text);
  return JSON.parse(r.content[0].text);
};
function cli(root, project, plan) {
  return new Promise((resolve, reject) => {
    const c = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/run-plan.mjs", import.meta.url)),
        "--project",
        project,
        "--plan",
        plan,
      ],
      {
        env: { ...process.env, LOCAL_API_DATA: root },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "",
      err = "",
      failure;
    const timer = setTimeout(() => {
      failure = Error("CLI timeout");
      c.kill();
    }, 15000);
    c.stdout.on("data", (b) => {
      out += b;
      if (Buffer.byteLength(out) > 2 * 1024 * 1024) {
        failure = Error("CLI output cap");
        c.kill();
      }
    });
    c.stderr.on("data", (b) => {
      err += b;
      if (Buffer.byteLength(err) > 16384) {
        failure = Error("CLI stderr cap");
        c.kill();
      }
    });
    c.on("error", (e) => {
      failure = e;
    });
    c.on("close", (code) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      try {
        assert.equal(code, 0, err + out);
        resolve(JSON.parse(out));
      } catch (e) {
        reject(e);
      }
    });
  });
}
for (const transport of ["http", "stdio"])
  test(
    `directory graph flow ${transport} SDK/owner/CLI runs frozen parents across two generations and restart`,
    { timeout: 30000 },
    async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), "graph-flow-")),
        wire = [];
      const peer = http.createServer((req, res) => {
        wire.push({ url: req.url, headers: req.headers });
        res.end("ok");
      });
      await new Promise((r) => peer.listen(0, "127.0.0.1", r));
      let app = await createApp({ root, port: 0 }),
        client;
      t.after(async () => {
        await client?.close();
        await close(app.server);
        await close(peer);
        await rm(root, { recursive: true, force: true });
      });
      const owner = async (route, data, status = 200) => {
        const r = await fetch(app.url + "/api/" + route, {
          method: "POST",
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          body: JSON.stringify(data),
        });
        const v = await r.json();
        assert.equal(r.status, status, JSON.stringify(v));
        return v;
      };
      const other = await app.store.create("Unrelated"),
        otherBefore = await app.store.get(other.id);
      const original = fixture(`http://127.0.0.1:${peer.address().port}`),
        originalBefore = structuredClone(original);
      const seed = await app.store.create("Native");
      let p = await owner(`projects/${seed.id}/import`, {
        document: original,
        inheritanceMode: "preserve",
      });
      const sourceBefore = await app.store.get(p.id);
      for (let generation = 0; generation < 2; generation++) {
        const next = await app.store.create("Next" + generation),
          doc = exportApipostDirectory(p);
        p = await owner(`projects/${next.id}/import`, {
          document: doc,
          inheritanceMode: "preserve",
        });
      }
      assert.equal(wire.length, 0);
      assert.deepEqual(original, originalBefore);
      assert.deepEqual(await app.store.get(seed.id), sourceBefore);
      const plan = p.plans[0];
      const frozen = structuredClone(plan);
      const verify = async (run) => {
        assert.equal(run.status, "passed");
        assert.equal(run.recordSaved, true);
        assert.equal(run.results.length, 2);
        assert.deepEqual(
          run.results.map((x) => x.response.status),
          [200, 200],
        );
        assert.deepEqual(run.snapshot.steps, frozen.steps);
        const rows = wire.slice(-2);
        assert.deepEqual(
          rows.map((r) => new URL(r.url, "http://local").pathname),
          ["/first", "/second"],
        );
        assert(
          rows.every(
            (r) =>
              r.headers["x-shared"] === "project" &&
              r.headers["x-folder"] === "folder" &&
              r.headers["x-environment"] === "selected" &&
              r.headers["x-extra"] === undefined,
          ),
        );
        const stored = await new Store(root).get(run.projectId || p.id);
        assert(stored.runs.some((r) => r.id === run.id));
      };
      await verify(await owner(`projects/${p.id}/run`, { planId: plan.id }));
      const ownerCreated = await owner(`projects/${p.id}/plans`, {
        name: "Owner-created strict flow",
        environmentId: plan.environmentId,
        statusPolicy: "strict200",
        steps: [{ request: p.requests[0] }],
      });
      assert.equal(ownerCreated.provenance.fields.name, "manual");
      const ownerRun = await owner(`projects/${p.id}/run`, {
        planId: ownerCreated.id,
      });
      assert.equal(ownerRun.status, "passed");
      assert.equal(ownerRun.recordSaved, true);
      assert.equal(wire.at(-1).headers["x-shared"], "project");
      p = await app.store.get(p.id);
      p.settings.nativeInheritance.projectLayer.headers[0].value =
        "live-changed";
      await app.store.save(p);
      await owner(`projects/${p.id}/execute`, { request: p.requests[0] });
      assert.equal(wire.at(-1).headers["x-shared"], "live-changed");
      // Existing parent values are shadowed by complete frozen rows, so this export
      // is representable; absence of a newly added row is not a native mask.
      const changed = exportApipostDirectory(p),
        roundtrip = empty();
      importIntoProject(roundtrip, changed, { inheritanceMode: "preserve" });
      assert.equal(
        roundtrip.plans[0].steps[0].request.headers.find(
          (h) => h.key === "X-Shared",
        ).value,
        "project",
      );
      if (transport === "http") {
        const { token } = await owner("mcp/config", {
          enabled: true,
          projects: [p.id],
          write: true,
          execute: true,
          remember: false,
        });
        client = new Client(
          { name: "graph-flow", version: "1" },
          { capabilities: {} },
        );
        await client.connect(
          new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
            requestInit: { headers: { authorization: "Bearer " + token } },
          }),
        );
      } else {
        client = new Client(
          { name: "graph-flow", version: "1" },
          { capabilities: {} },
        );
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [
              fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
              "--project",
              p.id,
              "--write",
              "--execute",
            ],
            env: { ...process.env, LOCAL_API_DATA: root },
            stderr: "pipe",
          }),
        );
      }
      const n = wire.length;
      const denied = await client.callTool({
        name: "localapi_run_plan",
        arguments: { projectId: other.id, planId: plan.id },
      });
      assert.equal(denied.isError, true);
      assert.equal(wire.length, n);
      await verify(
        decode(
          await client.callTool({
            name: "localapi_run_plan",
            arguments: { projectId: p.id, planId: plan.id },
          }),
        ),
      );
      const mcpCreated = decode(
        await client.callTool({
          name: "localapi_save_plan",
          arguments: {
            projectId: p.id,
            plan: {
              name: "SDK-created strict flow",
              environmentId: plan.environmentId,
              statusPolicy: "strict200",
              steps: [{ request: p.requests[0] }],
            },
          },
        }),
      );
      assert.equal(mcpCreated.provenance.fields.name, "ai");
      const mcpRun = decode(
        await client.callTool({
          name: "localapi_run_plan",
          arguments: { projectId: p.id, planId: mcpCreated.id },
        }),
      );
      assert.equal(mcpRun.status, "passed");
      assert.equal(mcpRun.recordSaved, true);
      assert.equal(wire.at(-1).headers["x-shared"], "live-changed");
      const createdDocument = exportApipostDirectory(await app.store.get(p.id));
      const migrated = await app.store.create("Created flows migrated");
      importIntoProject(migrated, createdDocument, {
        inheritanceMode: "preserve",
      });
      await app.store.save(migrated);
      assert.equal(migrated.plans.length, 3);
      assert(
        migrated.plans.every(
          (flow) =>
            Object.keys(flow.provenance.fields).length === 0 &&
            Object.keys(flow.provenance.steps).length === 0,
        ),
      );
      for (const [name, expected] of [
        [ownerCreated.name, "project"],
        [mcpCreated.name, "live-changed"],
      ]) {
        const flow = migrated.plans.find((flow) => flow.name === name);
        const run = await owner(`projects/${migrated.id}/run`, {
          planId: flow.id,
        });
        assert.equal(run.status, "passed");
        assert.equal(run.recordSaved, true);
        assert.equal(wire.at(-1).headers["x-shared"], expected);
      }
      await client.close();
      client = null;
      await verify(await cli(root, p.id, plan.id));
      p = await app.store.get(p.id);
      for (const kind of ["headers", "query", "cookies", "form"]) {
        const drift = structuredClone(p);
        drift.settings.nativeInheritance.projectLayer[kind].push({
          ...structuredClone(
            drift.settings.nativeInheritance.projectLayer.headers[0],
          ),
          key: "X-Extra",
          value: "must-not-inject",
        });
        const unchanged = structuredClone(drift),
          count = wire.length;
        assert.throws(
          () => exportApipostDirectory(drift),
          /独立HTTP冻结|继承表单/,
        );
        assert.deepEqual(drift, unchanged);
        assert.equal(wire.length, count);
      }
      assert.throws(() => exportApipost(p), /plans|冻结/);
      const restored = restoreProject(p);
      await app.store.save(restored);
      await close(app.server);
      app = await createApp({ root, port: 0 });
      const restarted = await cli(root, restored.id, plan.id);
      assert.equal(restarted.status, "passed");
      assert.equal(restarted.recordSaved, true);
      assert.deepEqual(restarted.snapshot.steps, frozen.steps);
      assert(wire.slice(-2).every((r) => r.headers["x-shared"] === "project"));
      const disk = await new Store(root).get(restored.id);
      assert(disk.runs.some((r) => r.id === restarted.id));
      assert.deepEqual(await app.store.get(other.id), otherBefore);
      assert.deepEqual(await app.store.get(seed.id), sourceBefore);
    },
  );

test("graph flow unsupported sources and semantic drift reject atomically", () => {
  for (const change of [
    (f) => {
      f.source = "mcp";
    },
    (f) => {
      f.steps[0].pre_script = 'throw Error("inert")';
    },
    (f) => {
      f.steps[0].api_snapshot.request.pre_tasks = [
        { type: "customScript", enabled: 1, data: "x=1" },
      ];
    },
    (f) => {
      f.environment_id = "missing";
    },
    (f) => {
      f.steps[1].step_id = f.steps[0].step_id;
    },
  ]) {
    const d = fixture(),
      entry = d.files.find((f) => f.path === "executions/flows/frozen.json"),
      f = JSON.parse(entry.text);
    change(f);
    entry.text = JSON.stringify(f);
    const p = empty(),
      before = structuredClone(p);
    assert.throws(() =>
      importIntoProject(p, d, { inheritanceMode: "preserve" }),
    );
    assert.deepEqual(p, before);
  }
  const p = empty();
  importIntoProject(p, fixture(), { inheritanceMode: "preserve" });
  for (const change of [
    (q) => {
      q.plans[0].steps[0].enabled = false;
    },
    (q) => {
      q.plans[0].statusPolicy = "assertions";
    },
    (q) => {
      q.plans[0].provenance.fields.external = "manual";
    },
    (q) => {
      q.plans[0].provenance.fields.name = "remote";
    },
    (q) => {
      q.plans[0].provenance.steps.unknown = "ai";
    },
    (q) => {
      q.plans[0].provenance.history = [];
    },
    (q) => {
      q.plans[0].externalHistory = {};
    },
    (q) => {
      q.plans[0].steps[0].externalMetadata = {};
    },
    (q) => {
      q.plans[0].steps[0].request.unknownMode = true;
    },
    (q) => {
      q.plans[0].steps[0].type = "repeat";
    },
    (q) => {
      q.plans[0].steps[0].request.afterScript = "x=1";
    },
  ]) {
    const q = structuredClone(p);
    change(q);
    const before = structuredClone(q);
    assert.throws(() => exportApipostDirectory(q));
    assert.deepEqual(q, before);
  }
});
