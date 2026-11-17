// Root-only CI workflows: repeat/native interchange/typed commit outcomes.
// Never execute locally as part of the inspected pure-helper checks.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  mkdtemp,
  rm,
  readdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { ProjectCommitUncertain } from "../src/project-commit-outcome.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";

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
    info: { name: tag, _postman_id: "same-original-id" },
    variable: [
      { key: "scope", value: tag },
      { key: "counter", value: 0, type: "number" },
      { key: "shadow", value: "collection" },
      { key: "pre", value: "old" },
      { key: "post", value: "old" },
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
              "?scope={{scope}}&counter={{counter}}&shadow={{shadow}}",
          },
        },
        event: [
          {
            listen: "prerequest",
            script: {
              exec: [
                "pm.collectionVariables.set('counter',pm.collectionVariables.get('counter')+1);",
              ],
            },
          },
        ],
      },
    ],
  };
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "collection-root-")),
    seen = [],
    clients = [];
  const peer = http.createServer((req, res) => {
    const url = new URL(req.url, "http://loopback");
    const value = {
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
    };
    seen.push(value);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(value));
  });
  await new Promise((r) => peer.listen(0, "127.0.0.1", r));
  let app = await createApp({ root, port: 0 });
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
    app.server.closeAllConnections();
    peer.closeAllConnections();
    await Promise.all(
      [app.server, peer].map((server) => new Promise((r) => server.close(r))),
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
  const connect = async (projectId, mode = "http", execute = false) => {
    const client = new Client(
      { name: "collection-root", version: "1" },
      { capabilities: {} },
    );
    clients.push(client);
    let transport;
    if (mode === "http") {
      const config = await owner("/api/mcp/config", "POST", {
        enabled: true,
        projects: [projectId],
        write: execute,
        execute,
        remember: false,
      });
      transport = new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + config.token } },
      });
    } else {
      transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
          "--project",
          projectId,
          ...(execute ? ["--write", "--execute"] : []),
        ],
        env: { LOCAL_API_DATA: root },
        stderr: "pipe",
      });
      transport.stderr.resume();
    }
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    assert(tools.some((tool) => tool.name === "localapi_export_project"));
    if (execute)
      assert(tools.some((tool) => tool.name === "localapi_execute_flow"));
    return (name, args) =>
      client.callTool({
        name: "localapi_" + name,
        arguments: { projectId, ...args },
      });
  };
  return {
    root,
    seen,
    owner,
    connect,
    get app() {
      return app;
    },
    base: "http://127.0.0.1:" + peer.address().port,
    async restart() {
      await Promise.all(
        clients.map((client) => client.close().catch(() => {})),
      );
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
      app = await createApp({ root, port: 0 });
    },
    async imported(tags = ["A", "B"]) {
      const project = await app.store.create("Root collection composition");
      project.environments[0].variables = { shadow: "environment" };
      project.globalVariables = { scope: "global", shadow: "global" };
      await app.store.save(project);
      for (const tag of tags)
        await owner(`/api/projects/${project.id}/import`, "POST", {
          document: document(this.base, tag),
          postmanVariableMode: "collection",
        });
      return app.store.get(project.id);
    },
  };
}

test(
  "root collection repeat A/B/A keeps occurrence identities, frozen bindings and backup/restart isolation",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      p = await f.imported(),
      [a, b] = p.requests;
    const [ca, cb] = p.postmanCollections.items;
    const saved = await f.owner(`/api/projects/${p.id}/plans`, "POST", {
      id: "collection-repeat",
      name: "twice A/B/A",
      statusPolicy: "strict200",
      environmentId: p.environments[0].id,
      steps: [
        {
          type: "repeat",
          id: "group",
          count: 2,
          steps: [
            { id: "a1", request: a },
            { id: "b1", request: b },
            { id: "a2", request: a },
          ],
        },
      ],
    });
    const call = await f.connect(p.id, "http", true);
    const run = decode(await call("execute_flow", { planId: saved.id }));
    const check = (result, expected) => {
      assert.equal(result.status, "passed");
      assert.equal(result.recordSaved, true);
      assert.equal(result.recordId, result.id);
      assert.deepEqual(
        result.results.map((r) => JSON.parse(r.response.body).query),
        expected.map(([scope, counter]) => ({
          scope,
          counter: String(counter),
          shadow: "environment",
        })),
      );
      assert.deepEqual(
        result.results.map((r) => r.stepId),
        ["a1", "b1", "a2", "a1", "b1", "a2"],
      );
      assert.deepEqual(
        result.results.map((r) => r.repeat.iteration),
        [0, 0, 0, 1, 1, 1],
      );
      assert.equal(
        new Set(result.results.map((r) => r.repeat.occurrenceId)).size,
        6,
      );
      assert(
        result.results.every(
          (r) => r.repeat.groupId === "group" && r.repeat.childId === r.stepId,
        ),
      );
    };
    check(run, [
      ["A", 1],
      ["B", 1],
      ["A", 2],
      ["A", 3],
      ["B", 2],
      ["A", 4],
    ]);
    const detail = decode(
      await call("get_execution_result", { runId: run.id }),
    );
    assert.deepEqual(detail.snapshot, run.snapshot);
    assert.equal(detail.planHash, run.planHash);
    const edited = await f.app.store.get(p.id);
    edited.requests[0] = {
      ...edited.requests[0],
      url: f.base + "/live-rebound",
      postmanCollectionId: cb.id,
    };
    edited.postmanCollections.items[0].variables.scope = "A-current";
    await f.owner(`/api/projects/${p.id}`, "PUT", edited);
    const second = await f.owner(`/api/projects/${p.id}/run`, "POST", {
      planId: saved.id,
    });
    check(second, [
      ["A-current", 5],
      ["B", 3],
      ["A-current", 6],
      ["A-current", 7],
      ["B", 4],
      ["A-current", 8],
    ]);
    assert.equal(second.planHash, run.planHash);
    assert.deepEqual(second.snapshot, run.snapshot);
    assert.equal(
      second.snapshot.steps[0].steps[0].request.postmanCollectionId,
      ca.id,
    );
    assert.deepEqual(
      second.results.map((r) => JSON.parse(r.response.body).path),
      ["/A", "/B", "/A", "/A", "/B", "/A"],
    );
    const backup = await f.owner(`/api/projects/${p.id}/export`);
    const restored = await f.owner(
      "/api/restore",
      "POST",
      { document: backup },
      201,
    );
    assert.deepEqual(restored.postmanCollections, backup.postmanCollections);
    assert.deepEqual(restored.plans, backup.plans);
    const beforeCount = f.seen.length;
    await f.restart();
    const recovered = await f.owner(`/api/projects/${restored.id}`);
    assert.deepEqual(recovered.runs, backup.runs);
    assert.deepEqual(recovered.plans, backup.plans);
    assert.equal(
      f.seen.length,
      beforeCount,
      "restore and restart do not replay requests",
    );
    const sourceBytes = await bytes(f.app.store.directory(p.id));
    const final = await f.owner(`/api/projects/${restored.id}/run`, "POST", {
      planId: saved.id,
    });
    check(final, [
      ["A-current", 9],
      ["B", 5],
      ["A-current", 10],
      ["A-current", 11],
      ["B", 6],
      ["A-current", 12],
    ]);
    assert.equal(final.planHash, run.planHash);
    assert.deepEqual(final.snapshot, run.snapshot);
    assert.deepEqual(await bytes(f.app.store.directory(p.id)), sourceBytes);
    assert.equal(f.seen.length, 18);
  },
);

test(
  "root both native exports reject collection layers before projection through owner and HTTP/stdio SDK without effects",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      p = await f.imported(["A"]);
    const original = structuredClone(p),
      before = await bytes(f.app.store.directory(p.id));
    for (const exporter of [exportApipost, exportApipostDirectory]) {
      assert.throws(() => exporter(p), /Postman collection.*完整项目备份/);
      assert.deepEqual(p, original);
      // No live API is required: an unused collection registry is still project data.
      assert.throws(
        () => exporter({ ...p, requests: [] }),
        /Postman collection.*完整项目备份/,
      );
    }
    for (const format of ["apipost", "apipost-directory"]) {
      const error = await f.owner(
        `/api/projects/${p.id}/export?format=${format}`,
        "GET",
        undefined,
        400,
      );
      assert.match(JSON.stringify(error), /Postman collection.*完整项目备份/);
    }
    for (const mode of ["http", "stdio"]) {
      const call = await f.connect(p.id, mode);
      for (const format of ["apipost", "apipost-directory"]) {
        const result = await call("export_project", { format });
        assert.equal(result.isError, true);
        assert.match(
          result.content[0].text,
          /Postman collection.*完整项目备份/,
        );
      }
    }
    assert.deepEqual(await f.app.store.get(p.id), original);
    assert.deepEqual(await bytes(f.app.store.directory(p.id)), before);
    assert.equal(f.seen.length, 0);
    const backup = await f.owner(`/api/projects/${p.id}/export`);
    const restored = await f.owner(
      "/api/restore",
      "POST",
      { document: backup },
      201,
    );
    await f.restart();
    const recovered = await f.owner(`/api/projects/${restored.id}`);
    assert.deepEqual(recovered.postmanCollections, original.postmanCollections);
    assert.equal(
      recovered.requests[0].postmanCollectionId,
      original.requests[0].postmanCollectionId,
    );
    assert.deepEqual(await bytes(f.app.store.directory(p.id)), before);
    assert.equal(f.seen.length, 0);
  },
);

test(
  "root collection admitted journal uncertainty survives later abort without false receipt, retry or replay",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      p = await f.imported(["A"]),
      other = await f.app.store.create("untouched");
    const collectionId = p.postmanCollections.items[0].id;
    await f.owner(`/api/projects/${p.id}/plans`, "POST", {
      id: "collection-unknown",
      name: "collection uncertainty",
      steps: [
        {
          id: "main",
          request: {
            ...p.requests[0],
            beforeScript: "pm.collectionVariables.set('pre','committed');",
            afterScript: "pm.collectionVariables.set('post','candidate');",
          },
        },
        {
          id: "never",
          request: {
            ...p.requests[0],
            url: f.base + "/must-not-replay",
            beforeScript: "",
            afterScript: "",
          },
        },
      ],
    });
    const store = f.app.store,
      before = await store.get(p.id),
      otherBefore = await bytes(store.directory(other.id));
    const originalSave = store.save,
      originalRead = store.readUnlocked;
    const directory = store.directory(p.id),
      plans = path.join(directory, "plans"),
      kept = path.join(directory, "plans-owned-backup");
    let attempts = 0,
      actualError,
      observedSignal,
      obstructed = false;
    store.save = async function (candidate, options) {
      if (
        candidate.id !== p.id ||
        options?.activity ||
        candidate.postmanCollections.items[0].variables.post !== "candidate"
      )
        return originalSave.call(this, candidate, options);
      attempts++;
      observedSignal = options?.signal;
      this.readUnlocked = async function (key, ...args) {
        const current = await originalRead.call(this, key, ...args);
        this.readUnlocked = originalRead;
        await rename(plans, kept);
        await writeFile(plans, "owned-collection-obstacle-secret");
        obstructed = true;
        return current;
      };
      try {
        return await originalSave.call(this, candidate, options);
      } catch (error) {
        actualError = error;
        // The real admitted journal failed first; a later abort cannot erase it.
        await f.owner("/api/cancel", "POST", { id: "collection-unknown-run" });
        throw error;
      } finally {
        this.readUnlocked = originalRead;
      }
    };
    let result;
    try {
      result = await f.owner(`/api/projects/${p.id}/run`, "POST", {
        planId: "collection-unknown",
        runId: "collection-unknown-run",
      });
    } finally {
      store.save = originalSave;
      store.readUnlocked = originalRead;
    }
    assert.equal(attempts, 1);
    assert.equal(observedSignal.aborted, true);
    assert(actualError instanceof ProjectCommitUncertain);
    assert.equal(actualError.projectId, p.id);
    assert.equal(result.status, "cancelled");
    assert.equal(result.results.length, 1);
    assert.equal(JSON.parse(result.results[0].response.body).path, "/A");
    assert.deepEqual(result.results[0].scopeCommit, {
      outcome: "unknown",
      retrySafe: false,
    });
    assert.equal(result.recordSaved, false);
    assert.equal(result.recordId, null);
    assert.equal(result.attemptedRecordId, result.id);
    assert.deepEqual(result.persistenceOutcome, {
      code: "PROJECT_COMMIT_UNCERTAIN",
      project_id: p.id,
      commit_outcome: "unknown",
      retry_safe: false,
    });
    assert(
      !JSON.stringify(result).includes("owned-collection-obstacle-secret"),
    );
    assert.equal(f.seen.length, 1);
    const journal = JSON.parse(
      await readFile(path.join(directory, ".transaction.json"), "utf8"),
    );
    assert.equal(journal.postmanCollections.items[0].id, collectionId);
    assert.equal(
      journal.postmanCollections.items[0].variables.pre,
      "committed",
    );
    assert.equal(
      journal.postmanCollections.items[0].variables.post,
      "candidate",
    );
    assert.equal(
      journal.runs.length,
      0,
      "failed evidence append never claims inclusion in the earlier scope journal",
    );
    assert.equal(obstructed, true);
    await rm(plans);
    await rename(kept, plans);
    const recovered = await new Store(f.root).get(p.id);
    assert.equal(recovered.configRevision, before.configRevision + 2);
    assert.equal(
      recovered.postmanCollections.items[0].variables.pre,
      "committed",
    );
    assert.equal(
      recovered.postmanCollections.items[0].variables.post,
      "candidate",
    );
    assert.equal(
      recovered.postmanCollections.items[0].definitions.post.initialValue,
      "old",
    );
    assert.equal(recovered.runs.length, 0);
    assert.deepEqual(await bytes(store.directory(other.id)), otherBefore);
    const restored = await f.owner(
      "/api/restore",
      "POST",
      { document: recovered },
      201,
    );
    await f.restart();
    assert.deepEqual(
      (await f.owner(`/api/projects/${restored.id}`)).postmanCollections,
      recovered.postmanCollections,
    );
    assert.equal(
      f.seen.length,
      1,
      "repair, restore and restart reconcile the admitted write without network replay",
    );
  },
);

test(
  "root repeat collection retirement guards enabled and disabled references while historical occurrences survive backup restart and SDK reads",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      p = await f.app.store.create("Repeat collection retirement"),
      other = await f.app.store.create("Unrelated repeat project"),
      source = document(f.base, "retire-repeat");
    // The retirement lifecycle needs no script execution or variable mutation.
    source.item[0].event = [];
    await f.owner(`/api/projects/${p.id}/import`, "POST", {
      document: source,
      postmanVariableMode: "collection",
    });
    const imported = await f.owner(`/api/projects/${p.id}`),
      live = imported.requests[0],
      collectionId = live.postmanCollectionId,
      otherBytes = await bytes(f.app.store.directory(other.id));
    const plan = await f.owner(`/api/projects/${p.id}/plans`, "POST", {
      id: "retire-repeat",
      name: "Historical repeat collection flow",
      statusPolicy: "strict200",
      environmentId: p.environments[0].id,
      steps: [
        {
          type: "repeat",
          id: "retire-group",
          count: 2,
          steps: [
            { id: "executed-child", request: live },
            { id: "disabled-child", enabled: false, request: live },
          ],
        },
      ],
    });
    const run = await f.owner(`/api/projects/${p.id}/run`, "POST", {
      planId: plan.id,
    });
    assert.equal(run.status, "passed");
    assert.equal(run.recordSaved, true);
    assert.equal(run.recordId, run.id);
    assert.equal(run.attemptedRecordId, run.id);
    assert.deepEqual(
      run.results.map((result) => result.stepId),
      ["executed-child", "executed-child"],
    );
    assert.deepEqual(
      run.results.map((result) => result.repeat.iteration),
      [0, 1],
    );
    assert.equal(
      new Set(run.results.map((result) => result.repeat.occurrenceId)).size,
      2,
    );
    const originalWire = [0, 1].map(() => ({
      path: "/retire-repeat",
      query: { scope: "retire-repeat", counter: "0", shadow: "collection" },
    }));
    assert.deepEqual(f.seen, originalWire);
    const all = await f.owner(`/api/projects/${p.id}`),
      savedRun = structuredClone(all.runs.find((item) => item.id === run.id)),
      allBytes = await bytes(f.app.store.directory(p.id));
    assert.equal(savedRun.id, run.id);
    assert.equal(savedRun.planHash, run.planHash);
    assert.deepEqual(savedRun.snapshot, run.snapshot);
    assert.deepEqual(savedRun.results, run.results);

    // Each candidate has just one bound repeat child and no live binding.
    // Disabled child/group checks must not be masked by an enabled reference.
    for (const kind of ["enabled-child", "disabled-child", "disabled-group"]) {
      const candidate = structuredClone(all);
      delete candidate.requests[0].postmanCollectionId;
      const group = candidate.plans[0].steps[0];
      group.steps = [group.steps[kind === "disabled-child" ? 1 : 0]];
      if (kind === "disabled-group") group.enabled = false;
      delete candidate.postmanCollections;
      const rejected = await f.owner(
        `/api/projects/${p.id}`,
        "PUT",
        candidate,
        400,
      );
      assert.match(JSON.stringify(rejected), /Postman collection 引用不存在/);
      assert.deepEqual(await f.owner(`/api/projects/${p.id}`), all);
      assert.deepEqual(await bytes(f.app.store.directory(p.id)), allBytes);
      assert.deepEqual(f.seen, originalWire);
    }

    // Remove the live and enabled child's bindings. The disabled repeat child
    // is now the actual last current reference, not only a rejected candidate.
    let current = await f.owner(`/api/projects/${p.id}`);
    delete current.requests[0].postmanCollectionId;
    delete current.plans[0].steps[0].steps[0].request.postmanCollectionId;
    await f.owner(`/api/projects/${p.id}`, "PUT", current);
    current = await f.owner(`/api/projects/${p.id}`);
    assert.equal(
      current.plans[0].steps[0].steps[1].request.postmanCollectionId,
      collectionId,
    );
    const lastBytes = await bytes(f.app.store.directory(p.id)),
      premature = structuredClone(current);
    delete premature.postmanCollections;
    assert.match(
      JSON.stringify(
        await f.owner(`/api/projects/${p.id}`, "PUT", premature, 400),
      ),
      /Postman collection 引用不存在/,
    );
    assert.deepEqual(await bytes(f.app.store.directory(p.id)), lastBytes);
    delete current.plans[0].steps[0].steps[1].request.postmanCollectionId;
    delete current.postmanCollections;
    await f.owner(`/api/projects/${p.id}`, "PUT", current);
    const retired = await f.owner(`/api/projects/${p.id}`);
    assert.equal(Object.hasOwn(retired, "postmanCollections"), false);
    assert.equal(retired.plans[0].steps[0].count, 2);
    assert.equal(retired.plans[0].steps[0].steps[1].enabled, false);
    assert(
      retired.plans[0].steps[0].steps.every(
        (child) => !Object.hasOwn(child.request, "postmanCollectionId"),
      ),
    );
    assert.deepEqual(
      retired.runs.find((item) => item.id === run.id),
      savedRun,
    );
    const retiredBytes = await bytes(f.app.store.directory(p.id));
    assert.match(
      JSON.stringify(
        await f.owner(`/api/projects/${p.id}/plans`, "POST", run.snapshot, 400),
      ),
      /Postman collection 引用不存在/,
    );
    assert.deepEqual(await bytes(f.app.store.directory(p.id)), retiredBytes);
    const backup = await f.owner(`/api/projects/${p.id}/export`),
      restored = await f.owner(
        "/api/restore",
        "POST",
        { document: backup },
        201,
      );
    assert.notEqual(restored.id, p.id);
    await f.restart();
    const recovered = await f.owner(`/api/projects/${restored.id}`);
    assert.equal(Object.hasOwn(recovered, "postmanCollections"), false);
    assert.deepEqual(recovered.plans, retired.plans);
    assert.deepEqual(
      recovered.runs.find((item) => item.id === run.id),
      savedRun,
    );
    const restoredBytes = await bytes(f.app.store.directory(restored.id));
    for (const mode of ["http", "stdio"]) {
      const call = await f.connect(restored.id, mode);
      const detail = decode(
        await call("get_execution_result", { runId: run.id }),
      );
      assert.deepEqual(detail, savedRun);
      assert.equal(detail.planHash, run.planHash);
      assert.deepEqual(detail.snapshot, run.snapshot);
      assert.deepEqual(detail.results, run.results);
      const denied = await call("get_execution_result", {
        projectId: p.id,
        runId: run.id,
      });
      assert.equal(denied.isError, true);
    }
    assert.deepEqual(await bytes(f.app.store.directory(p.id)), retiredBytes);
    assert.deepEqual(
      await bytes(f.app.store.directory(restored.id)),
      restoredBytes,
    );
    assert.deepEqual(await bytes(f.app.store.directory(other.id)), otherBytes);
    assert.deepEqual(
      f.seen,
      originalWire,
      "retirement and historical repeat reads never replay either occurrence",
    );
  },
);
