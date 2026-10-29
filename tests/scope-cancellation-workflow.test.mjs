import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  rm,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { snapshotPlan } from "../src/core.mjs";
import { installScopeSaveLockGate } from "./helpers/scope-save-lock-gate.mjs";

async function waitFor(read) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline)
      throw Error("scope workflow observation timed out");
    await delay(10);
  }
}
async function ready(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function configurationBytes(directory) {
  const files = {};
  async function visit(folder, prefix = "") {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) {
        if (name !== "history")
          await visit(path.join(folder, entry.name), name + "/");
      } else if (name !== "project.json")
        files[name] = (await readFile(path.join(folder, entry.name))).toString(
          "base64",
        );
    }
  }
  await visit(directory);
  return files;
}
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
for (const mode of ["owner", "http", "stdio"])
  test(
    `${mode} queued pre/post scope saves honor cancellation before transaction admission and retain readable terminal evidence`,
    { timeout: 30000 },
    async (t) => {
      const temporary = await mkdtemp(
          path.join(tmpdir(), "scope-save-cancel-"),
        ),
        root = path.join(temporary, "data"),
        gate = path.join(temporary, "gate");
      await mkdir(gate);
      let app = await createApp({ root, port: 0 }),
        client,
        undo;
      const seen = [];
      const peer = http.createServer((req, res) => {
        seen.push(req.url);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ path: req.url }));
      });
      await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
      t.after(async () => {
        await Promise.all(
          ["pre", "post"].map((label) =>
            writeFile(path.join(gate, label + ".release"), "release").catch(
              () => {},
            ),
          ),
        );
        await client?.close().catch(() => {});
        undo?.();
        app.server.closeAllConnections();
        peer.closeAllConnections();
        await Promise.all(
          [app.server, peer].map(
            (server) => new Promise((resolve) => server.close(resolve)),
          ),
        );
        await rm(temporary, { recursive: true, force: true });
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
      const base = "http://127.0.0.1:" + peer.address().port,
        projects = [];
      for (const phase of ["pre", "post"]) {
        const p = await app.store.create(mode + " " + phase),
          env = p.environments[0];
        env.variables = { value: "old", kept: "old" };
        p.globalVariables = { value: "old", kept: "old" };
        const edit = `pm.environment.set('value','new');pm.globals.set('value','new');pm.environment.set('scopeGate','${phase}');`;
        const before =
          phase === "pre"
            ? `await pm.sendRequest('${base}/${phase}/before-marker');${edit}`
            : `pm.environment.set('kept','pre-committed');pm.globals.set('kept','pre-committed');`;
        const after =
          phase === "post"
            ? `await pm.sendRequest('${base}/${phase}/after-marker');${edit}`
            : "";
        p.plans = [
          snapshotPlan({
            id: "flow",
            name: phase,
            environmentId: env.id,
            steps: [
              {
                request: {
                  name: phase,
                  url: base + "/" + phase + "/main",
                  beforeScript: before,
                  afterScript: after,
                },
              },
              {
                request: {
                  name: "must not execute",
                  url: base + "/" + phase + "/later",
                },
              },
            ],
          }),
        ];
        await app.store.save(p);
        projects.push(p);
      }
      const other = await app.store.create("untouched"),
        otherBefore = await app.store.get(other.id),
        otherBytes = await configurationBytes(app.store.directory(other.id));
      let cancelAck;
      if (mode === "owner" || mode === "http")
        undo = installScopeSaveLockGate(app.store, gate);
      if (mode !== "owner") {
        client = new Client({ name: "scope-save-" + mode, version: "1" });
        let transport;
        if (mode === "http") {
          const config = await owner("/api/mcp/config", "POST", {
            enabled: true,
            projects: projects.map((p) => p.id),
            write: true,
            execute: true,
          });
          transport = new StreamableHTTPClientTransport(
            new URL(app.url + "/mcp"),
            {
              requestInit: {
                headers: { Authorization: "Bearer " + config.token },
              },
              fetch: async (url, init) => {
                const message =
                  typeof init?.body === "string" ? JSON.parse(init.body) : null;
                const response = await fetch(url, init);
                if (message?.method === "notifications/cancelled")
                  cancelAck?.resolve(response.status);
                return response;
              },
            },
          );
        } else
          transport = new StdioClientTransport({
            command: process.execPath,
            args: [
              "--import",
              new URL("./helpers/scope-save-lock-preload.mjs", import.meta.url)
                .href,
              fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
              ...projects.flatMap((p) => ["--project", p.id]),
              "--write",
              "--execute",
            ],
            env: { LOCAL_API_DATA: root, LOCAL_API_SCOPE_GATE: gate },
            stderr: "pipe",
          });
        await client.connect(transport);
        assert(
          (await client.listTools()).tools.some(
            (tool) => tool.name === "localapi_execute_flow",
          ),
        );
      }
      for (const [index, phase] of ["pre", "post"].entries()) {
        const p = projects[index],
          before = await app.store.get(p.id);
        await writeFile(
          path.join(gate, "armed.json"),
          JSON.stringify({ label: phase, projectId: p.id }),
        );
        const controller = new AbortController();
        cancelAck = Promise.withResolvers();
        const pending =
          mode === "owner"
            ? owner(`/api/projects/${p.id}/run`, "POST", {
                planId: "flow",
                runId: "queued-" + phase,
              })
            : client.callTool(
                {
                  name: "localapi_execute_flow",
                  arguments: { projectId: p.id, planId: "flow" },
                },
                undefined,
                { signal: controller.signal },
              );
        // Attach rejection handling before cancellation or any assertion can fail.
        const outcome = pending.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        let checkpoint;
        try {
          checkpoint = await waitFor(() =>
            ready(path.join(gate, phase + ".ready")),
          );
          assert.equal(
            checkpoint.settled,
            false,
            "real Store.save remains behind its owned project lock",
          );
          const bytesAtAdmission = await configurationBytes(
            app.store.directory(p.id),
          );
          assert(!Object.hasOwn(bytesAtAdmission, ".transaction.json"));
          if (mode === "owner")
            await owner("/api/cancel", "POST", { id: "queued-" + phase });
          else {
            controller.abort();
            assert.match(String((await outcome).error), /abort|cancel/i);
            if (mode === "http") assert.equal(await cancelAck.promise, 202);
            // Stdio routes cancellation synchronously before the following ping.
            await client.ping();
          }
          await writeFile(path.join(gate, phase + ".release"), "release");
          const saved = await waitFor(async () => {
            const current = await new Store(root).get(p.id);
            return (
              current.runs.some((r) => r.status === "cancelled") && current
            );
          });
          if (mode === "owner") {
            const answer = await outcome;
            assert.equal(answer.error, undefined);
            assert.equal(answer.value.status, "cancelled");
            assert.equal(answer.value.recordSaved, true);
          }
          assert.equal(
            checkpoint.signalForwarded,
            true,
            "scope helper forwards the execution AbortSignal",
          );
          assert.deepEqual(
            await configurationBytes(app.store.directory(p.id)),
            bytesAtAdmission,
            "only terminal history/metadata may change after the rejected scope transaction",
          );
          assert.equal(
            saved.configRevision,
            before.configRevision + (phase === "post" ? 1 : 0),
          );
          assert.equal(saved.environments[0].variables.value, "old");
          assert.equal(saved.globalVariables.value, "old");
          assert.equal(
            saved.environments[0].variables.kept,
            phase === "post" ? "pre-committed" : "old",
          );
          assert.equal(
            saved.globalVariables.kept,
            phase === "post" ? "pre-committed" : "old",
          );
          assert.equal(saved.environments[0].variables.scopeGate, undefined);
          const run = saved.runs[0];
          assert.equal(run.status, "cancelled");
          assert.equal(run.results.length, 1);
          assert.match(run.results[0].error, /取消/);
          assert.equal(Boolean(run.results[0].response), phase === "post");
          if (phase === "post")
            assert.equal(
              JSON.parse(run.results[0].response.body).path,
              "/post/main",
            );
          assert.deepEqual(
            seen.filter((url) => url.startsWith("/" + phase + "/")),
            phase === "pre"
              ? ["/pre/before-marker"]
              : ["/post/main", "/post/after-marker"],
          );
          assert.deepEqual(saved.plans, before.plans);
          assert.deepEqual(await app.store.get(other.id), otherBefore);
          assert.deepEqual(
            await configurationBytes(app.store.directory(other.id)),
            otherBytes,
          );
          if (client) {
            const read = decode(
              await client.callTool({
                name: "localapi_get_execution_result",
                arguments: { projectId: p.id, runId: run.id },
              }),
            );
            assert.equal(read.status, "cancelled");
            assert.deepEqual(read.results, run.results);
          }
          const backup = await owner(`/api/projects/${p.id}/export`);
          const restored = await owner(
            "/api/restore",
            "POST",
            { document: backup },
            201,
          );
          assert.notEqual(restored.id, p.id);
          assert.deepEqual(restored.runs, saved.runs);
          assert.deepEqual(restored.globalVariables, saved.globalVariables);
          assert.deepEqual(restored.environments, saved.environments);
        } finally {
          await writeFile(path.join(gate, phase + ".release"), "release");
        }
      }
      await client?.close();
      client = undefined;
      undo?.();
      undo = undefined;
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
      app = await createApp({ root, port: 0 });
      // Fresh process-local app state, unchanged original frozen plans; no implicit
      // replay on restart. A separate explicit owner run proves later saves work.
      const count = seen.length;
      for (const p of projects) {
        const saved = await app.store.get(p.id);
        assert.equal(saved.runs[0].status, "cancelled");
        assert.equal(saved.environments[0].variables.value, "old");
      }
      assert.equal(seen.length, count);
      const completed = await owner(
        `/api/projects/${projects[0].id}/run`,
        "POST",
        { planId: "flow" },
      );
      assert.equal(completed.status, "passed");
      assert.equal(completed.recordSaved, true);
      assert.equal(seen.length, count + 3);
      const accepted = await app.store.get(projects[0].id);
      assert.equal(accepted.environments[0].variables.value, "new");
      assert.equal(accepted.globalVariables.value, "new");
      assert.deepEqual(await app.store.get(other.id), otherBefore);
    },
  );

test("confirmed real Store scope commit remains acknowledged when abort arrives before caller continuation", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "scope-confirmed-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root),
    p = await store.create("confirmed");
  p.environments[0].variables = { value: "old" };
  await store.save(p);
  const before = await store.get(p.id),
    controller = new AbortController(),
    original = store.save.bind(store);
  let saves = 0;
  store.save = async (candidate, options) => {
    saves++;
    const result = await original(candidate, options);
    controller.abort();
    return result;
  };
  const { persistScopeChanges } = await import("../src/variable-scopes.mjs");
  const accepted = await persistScopeChanges(
    store,
    p.id,
    p.environments[0].id,
    [
      {
        scope: "environment",
        name: "value",
        before: { exists: true, value: "old" },
        after: { exists: true, value: "new" },
      },
    ],
    { signal: controller.signal },
  );
  assert.equal(saves, 1);
  assert.equal(controller.signal.aborted, true);
  assert.equal(accepted.scopes.environment.value, "new");
  const restarted = await new Store(root).get(p.id);
  assert.equal(restarted.configRevision, before.configRevision + 1);
  assert.equal(restarted.environments[0].variables.value, "new");
  assert.equal(restarted.runs.length, 0);
});

test(
  "edited and archived in-flight plan retains cancelled frozen evidence across restart and explicit MCP reauthorization",
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "scope-archive-lifecycle-"));
    let app = await createApp({ root, port: 0 });
    const clients = new Set(),
      seen = [];
    let heldResponse, pending;
    let settled = false;
    const peer = http.createServer((req, res) => {
      seen.push(req.url);
      if (req.url === "/original-held") heldResponse = res;
      else res.end("unexpected later dispatch");
    });
    await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      // A socket close alone does not await the owner handler's final append.
      // On an earlier assertion failure, cancel and settle it before removing storage.
      if (pending) {
        if (!settled)
          await owner("/api/cancel", "POST", {
            id: "archive-lifecycle-running",
          }).catch(() => {});
        await pending;
      }
      await Promise.all(
        [...clients].map((client) => client.close().catch(() => {})),
      );
      app.server.closeAllConnections();
      peer.closeAllConnections();
      await Promise.all(
        [app.server, peer].map(
          (server) => new Promise((resolve) => server.close(resolve)),
        ),
      );
      await rm(root, { recursive: true, force: true });
    });
    const owner = async (route, method = "GET", body) => {
      const response = await fetch(app.url + route, {
        method,
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await response.json();
      assert.equal(response.status, 200, JSON.stringify(value));
      return value;
    };
    const base = "http://127.0.0.1:" + peer.address().port;
    const p = await app.store.create("original project");
    p.plans = [
      snapshotPlan({
        id: "archive-lifecycle-flow",
        name: "original plan",
        environmentId: p.environments[0].id,
        steps: [
          {
            id: "held",
            request: { name: "original held", url: base + "/original-held" },
          },
          {
            id: "later",
            request: { name: "original later", url: base + "/original-later" },
          },
        ],
      }),
    ];
    await app.store.save(p);
    const before = await app.store.get(p.id),
      original = structuredClone(before.plans[0]);
    const other = await app.store.create("untouched peer project");
    const otherBefore = await app.store.get(other.id);
    const configure = (projects) =>
      owner("/api/mcp/config", "POST", {
        enabled: true,
        remember: true,
        projects,
        write: false,
        execute: false,
      });
    const config = await configure([p.id, other.id]);
    const connect = async (mode, projects = [other.id]) => {
      const client = new Client({
        name: "archive-lifecycle-" + mode,
        version: "1",
      });
      clients.add(client);
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
                ...projects.flatMap((id) => ["--project", id]),
              ],
              env: { LOCAL_API_DATA: root },
              stderr: "pipe",
            }),
      );
      const tools = (await client.listTools()).tools;
      assert(
        tools.some((tool) => tool.name === "localapi_get_execution_result"),
      );
      assert(!tools.some((tool) => tool.name === "localapi_execute_flow"));
      return client;
    };
    const closeClient = async (client) => {
      await client.close();
      clients.delete(client);
    };
    const list = (client, projectId) =>
      client.callTool({
        name: "localapi_list_execution_runs",
        arguments: { projectId },
      });
    const denied = async (client, pattern) => {
      const value = await list(client, p.id);
      assert.equal(value.isError, true);
      assert.match(value.content[0].text, pattern);
      assert.deepEqual(decode(await list(client, other.id)), []);
    };
    let httpReader = await connect("http"),
      stdioReader = await connect("stdio", [p.id, other.id]);
    for (const reader of [httpReader, stdioReader])
      assert.deepEqual(decode(await list(reader, p.id)), []);

    pending = owner(`/api/projects/${p.id}/run`, "POST", {
      planId: original.id,
      runId: "archive-lifecycle-running",
    }).then(
      (value) => {
        settled = true;
        return { value };
      },
      (error) => {
        settled = true;
        return { error };
      },
    );
    await waitFor(() => heldResponse);
    assert.deepEqual(seen, ["/original-held"]);
    const editedInput = structuredClone(original);
    editedInput.name = "edited plan";
    editedInput.steps[0].request.url = base + "/edited-held";
    editedInput.steps[1].request.url = base + "/edited-later";
    await owner(`/api/projects/${p.id}/plans`, "POST", {
      ...editedInput,
      projectConfigRevision: before.configRevision,
    });
    const edited = await owner(`/api/projects/${p.id}`);
    assert.equal(edited.plans[0].name, "edited plan");
    assert.equal(edited.plans[0].steps[0].request.url, base + "/edited-held");
    assert.equal(edited.configRevision, before.configRevision + 1);
    const archived = await owner(`/api/projects/${p.id}`, "PUT", {
      ...edited,
      name: "edited archived project",
      archived: true,
    });
    assert.equal(archived.configRevision, before.configRevision + 2);
    assert.equal(archived.archived, true);
    assert.deepEqual(archived.runs, []);
    const archivedBytes = await configurationBytes(app.store.directory(p.id));
    const remembered = JSON.parse(
      await readFile(path.join(root, ".mcp-config.json"), "utf8"),
    );
    assert.deepEqual(remembered.projects, [other.id]);
    assert.equal(remembered.token, config.token);
    await denied(httpReader, /未授权/);
    await denied(stdioReader, /已归档/);
    assert.equal(
      settled,
      false,
      "successful archive must not implicitly cancel already-dispatched owner work",
    );
    assert.equal(heldResponse.destroyed, false);
    await owner("/api/cancel", "POST", { id: "archive-lifecycle-running" });
    const answer = await pending;
    assert.equal(answer.error, undefined);
    const run = answer.value;
    assert.equal(run.status, "cancelled");
    assert.equal(run.recordSaved, true);
    assert.equal(run.persistenceError, undefined);
    assert.equal(run.results.length, 1);
    assert.equal(run.results[0].stepId, "held");
    assert.equal(run.results[0].request.url, base + "/original-held");
    assert.equal(run.results[0].response, undefined);
    assert.equal(typeof run.results[0].error, "string");
    assert(run.results[0].error.length > 0);
    const expectedSnapshot = structuredClone(original);
    for (const step of expectedSnapshot.steps)
      step.request.serviceSnapshot = true;
    assert.deepEqual(run.snapshot, expectedSnapshot);
    assert.equal(
      run.planHash,
      createHash("sha256")
        .update(JSON.stringify(expectedSnapshot))
        .digest("hex"),
    );
    assert.equal(run.planName, "original plan");
    const saved = await owner(`/api/projects/${p.id}`);
    assert.equal(saved.name, "edited archived project");
    assert.equal(saved.archived, true);
    assert.equal(saved.configRevision, archived.configRevision);
    assert.deepEqual(saved.plans, archived.plans);
    assert.deepEqual(
      await configurationBytes(app.store.directory(p.id)),
      archivedBytes,
    );
    assert.equal(saved.runs.length, 1);
    const record = saved.runs[0];
    assert.equal(record.id, run.id);
    assert.equal(record.source, "manual");
    assert.equal(record.status, "cancelled");
    assert.equal(record.planHash, run.planHash);
    assert.deepEqual(record.snapshot, run.snapshot);
    assert.deepEqual(record.results, run.results);
    assert.deepEqual(seen, ["/original-held"]);
    await denied(httpReader, /未授权/);
    await denied(stdioReader, /已归档/);
    assert.deepEqual(await app.store.get(other.id), otherBefore);

    await closeClient(httpReader);
    await closeClient(stdioReader);
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    app = await createApp({ root, port: 0 });
    const restarted = await owner(`/api/projects/${p.id}`);
    assert.equal(restarted.archived, true);
    assert.equal(restarted.configRevision, archived.configRevision);
    assert.deepEqual(restarted.plans, archived.plans);
    assert.deepEqual(restarted.runs, [record]);
    const restartedConfig = await owner("/api/mcp/config");
    assert.equal(restartedConfig.enabled, true);
    assert.equal(restartedConfig.token, config.token);
    assert.deepEqual(restartedConfig.projects, [other.id]);
    httpReader = await connect("http");
    // Stdio authorization is independent: the restarted reader initially receives
    // only the unrelated project, never authority inherited from HTTP config.
    stdioReader = await connect("stdio");
    await denied(httpReader, /未授权/);
    await denied(stdioReader, /未授权/);
    const unarchived = await owner(`/api/projects/${p.id}`, "PUT", {
      ...restarted,
      archived: false,
    });
    assert.equal(unarchived.archived, false);
    assert.deepEqual(unarchived.runs, [record]);
    await denied(httpReader, /未授权/);
    await denied(stdioReader, /未授权/);
    assert.deepEqual((await owner("/api/mcp/config")).projects, [other.id]);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(root, ".mcp-config.json"), "utf8"))
        .projects,
      [other.id],
    );
    const reauthorized = await configure([p.id, other.id]);
    assert.equal(reauthorized.token, config.token);
    await denied(stdioReader, /未授权/);
    await closeClient(stdioReader);
    stdioReader = await connect("stdio", [p.id, other.id]);
    for (const reader of [httpReader, stdioReader]) {
      const detail = decode(
        await reader.callTool({
          name: "localapi_get_execution_result",
          arguments: { projectId: p.id, runId: record.id },
        }),
      );
      assert.deepEqual(detail, record);
      const summaries = decode(await list(reader, p.id));
      assert.equal(summaries.length, 1);
      assert.equal(summaries[0].id, record.id);
      assert.equal(summaries[0].status, "cancelled");
      assert.equal(summaries[0].planHash, record.planHash);
      assert.deepEqual(decode(await list(reader, other.id)), []);
    }
    const final = await owner(`/api/projects/${p.id}`);
    assert.deepEqual(final.plans, archived.plans);
    assert.deepEqual(final.runs, [record]);
    assert.equal(final.configRevision, archived.configRevision + 1);
    assert.deepEqual(await app.store.get(other.id), otherBefore);
    assert.deepEqual(
      seen,
      ["/original-held"],
      "restart, reauthorization and reads must never replay either plan version",
    );
  },
);
