import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createApp } from "../src/server.mjs";
import { acquireFileLock } from "../src/file-lock.mjs";
import { MCPConfigPublication } from "../src/mcp-config-publication.mjs";

function bounded(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(label)), 3000);
    }),
  ]).finally(() => clearTimeout(timer));
}

test(
  "successive reductions supersede old publication and persist their intersection",
  { timeout: 10000 },
  async (t) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "mcp-successive-fences-"),
    );
    const app = await createApp({ root, port: 0 });
    const outcomes = [];
    let release;
    t.after(async () => {
      await release?.();
      await Promise.allSettled(outcomes);
      app.server.closeAllConnections();
      await new Promise((done) => app.server.close(done));
      await rm(root, { recursive: true, force: true });
    });
    const owner = async (route, body) => {
      const response = await fetch(app.url + route, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, value: await response.json() };
    };
    const a = (await owner("/api/projects", { name: "Removed" })).value;
    const b = (await owner("/api/projects", { name: "Still granted" })).value;
    const config = {
      enabled: true,
      remember: true,
      write: true,
      execute: true,
      projects: [a.id, b.id],
    };
    const before = await owner("/api/mcp/config", config);
    const disk = await readFile(path.join(root, ".mcp-config.json"));
    release = await acquireFileLock(app.store.lockFile(a.id));
    let admitted;
    const original = MCPConfigPublication.prototype.run;
    t.mock.method(MCPConfigPublication.prototype, "run", function (operation) {
      const task = original.call(this, operation);
      admitted?.();
      return task;
    });
    const submit = async (value) => {
      const entered = new Promise((resolve) => {
        admitted = resolve;
      });
      const index = outcomes.length;
      outcomes.push(owner("/api/mcp/config", value));
      await bounded(entered, "owner operation not admitted");
      return index;
    };
    const old = await submit(config);
    const first = await submit({ ...config, execute: false });
    const second = await submit({
      ...config,
      execute: false,
      projects: [b.id],
    });
    const current = (await owner("/api/mcp/config")).value;
    assert.equal(current.execute, false);
    assert.equal(current.write, true);
    assert.equal(current.token, before.value.token);
    assert.deepEqual(current.projects, [b.id]);
    assert.equal(
      (await readFile(path.join(root, ".mcp-config.json"))).equals(disk),
      true,
    );
    await release();
    release = null;
    const settled = await bounded(
      Promise.all(outcomes),
      "queued publications did not settle",
    );
    assert.equal(settled[old].status, 400);
    assert.equal(settled[first].status, 400);
    assert.match(settled[first].value.error, /减权请求替代/);
    assert.equal(settled[second].status, 200);
    const saved = JSON.parse(
      await readFile(path.join(root, ".mcp-config.json"), "utf8"),
    );
    assert.equal(saved.execute, false);
    assert.equal(saved.write, true);
    assert.deepEqual(saved.projects, [b.id]);
    for (const project of [a, b]) {
      const response = await fetch(app.url + "/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + before.value.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: project.id,
          method: "tools/call",
          params: {
            name: "localapi_list_apis",
            arguments: { projectId: project.id },
          },
        }),
      });
      const result = (await response.json()).result;
      assert.equal(Boolean(result.isError), project.id === a.id);
    }
  },
);

for (const mode of ["disable", "write", "execute", "projects"])
  test(
    `owner ${mode} fences before actual project lock releases the older publication`,
    { timeout: 10000 },
    async (t) => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "mcp-revocation-fence-"),
      );
      const app = await createApp({ root, port: 0 });
      let release, update, older;
      t.after(async () => {
        await release?.();
        await update?.catch(() => {});
        await older?.catch(() => {});
        app.server.closeAllConnections();
        await new Promise((done) => app.server.close(done));
        await rm(root, { recursive: true, force: true });
      });
      const owner = async (url, method = "GET", body) => {
        const response = await fetch(app.url + url, {
          method,
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, value: await response.json() };
      };
      const project = (
        await owner("/api/projects", "POST", { name: "Synthetic fence target" })
      ).value;
      const retained = (
        await owner("/api/projects", "POST", {
          name: "Retained independent project",
        })
      ).value;
      const config = {
        enabled: true,
        remember: true,
        projects: [project.id, retained.id],
        write: true,
        execute: true,
      };
      const granted = await owner("/api/mcp/config", "POST", config);
      assert.equal(granted.status, 200);
      const before = await readFile(path.join(root, ".mcp-config.json"));
      release = await acquireFileLock(app.store.lockFile(project.id));
      let firstEntered, entered;
      const firstAdmitted = new Promise((resolve) => {
        firstEntered = resolve;
      });
      const admitted = new Promise((resolve) => {
        entered = resolve;
      });
      let admissions = 0;
      const originalRun = MCPConfigPublication.prototype.run;
      t.mock.method(
        MCPConfigPublication.prototype,
        "run",
        function (operation) {
          const task = originalRun.call(this, operation);
          if (++admissions === 1) firstEntered();
          else entered();
          return task;
        },
      );
      older = owner("/api/mcp/config", "POST", config);
      await bounded(firstAdmitted, "older owner publication was not admitted");
      let replied = false;
      update = owner("/api/mcp/config", "POST", {
        ...config,
        ...(mode === "disable"
          ? { enabled: false }
          : mode === "write"
            ? { write: false }
            : mode === "execute"
              ? { execute: false }
              : { projects: [retained.id] }),
      }).finally(() => {
        replied = true;
      });
      await bounded(admitted, "owner publication was not admitted");
      assert.equal(
        replied,
        false,
        "no success before persistence confirmation",
      );
      const rpc = await fetch(app.url + "/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + granted.value.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      if (mode === "disable")
        assert.equal(
          rpc.status,
          403,
          "valid owner disable must fence admission before project-lock wait",
        );
      else {
        assert.equal(rpc.status, 200);
        const names = (await rpc.json()).result.tools.map((tool) => tool.name);
        if (mode === "write")
          assert.equal(names.includes("localapi_create_project"), false);
        if (mode === "write" || mode === "execute")
          assert.equal(names.includes("localapi_execute_flow"), false);
        const policy = (await owner("/api/mcp/config")).value;
        assert.equal(policy.projects.includes(retained.id), true);
        assert.equal(policy.write, mode !== "write");
        assert.equal(policy.execute, mode !== "write" && mode !== "execute");
        assert.equal(policy.projects.includes(project.id), mode !== "projects");
        if (mode === "projects") {
          const denied = await fetch(app.url + "/mcp", {
            method: "POST",
            headers: {
              Authorization: "Bearer " + granted.value.token,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: {
                name: "localapi_list_apis",
                arguments: { projectId: project.id },
              },
            }),
          });
          assert.equal((await denied.json()).result.isError, true);
        }
      }
      assert.equal(
        (await readFile(path.join(root, ".mcp-config.json"))).equals(before),
        true,
      );
      await release();
      release = null;
      const settled = await bounded(
        update,
        "owner publication did not settle after lock release",
      );
      assert.equal(
        (await older).status,
        400,
        "pre-fence owner cannot republish grants",
      );
      assert.equal(settled.status, 200);
      assert.equal(settled.value.enabled, mode !== "disable");
      assert.equal(
        JSON.parse(await readFile(path.join(root, ".mcp-config.json"), "utf8"))
          .enabled,
        mode !== "disable",
      );
    },
  );

test(
  "partial MCP and owner bodies cannot cross a later revocation fence",
  { timeout: 10000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-body-fence-"));
    const app = await createApp({ root, port: 0 });
    const pending = [];
    t.after(async () => {
      for (const request of pending) request.destroy();
      app.server.closeAllConnections();
      await new Promise((done) => app.server.close(done));
      await rm(root, { recursive: true, force: true });
    });
    const owner = async (route, body) => {
      const response = await fetch(app.url + route, {
        method: "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, value: await response.json() };
    };
    const project = (
      await owner("/api/projects", { name: "Synthetic slow-body project" })
    ).value;
    const config = {
      enabled: true,
      remember: true,
      write: true,
      execute: true,
      projects: [project.id],
    };
    const grant = await owner("/api/mcp/config", config);
    const start = async (route, value, headers) => {
      const bytes = JSON.stringify(value);
      let entered;
      const admitted = new Promise((resolve) => {
        entered = resolve;
      });
      const listener = (request) => {
        if (request.headers["x-fence-fixture"] === route) {
          app.server.off("request", listener);
          entered();
        }
      };
      app.server.on("request", listener);
      let request;
      const outcome = new Promise((resolve, reject) => {
        request = http.request(
          app.url + route,
          {
            method: "POST",
            headers: {
              ...headers,
              "content-type": "application/json",
              "content-length": Buffer.byteLength(bytes),
              "x-fence-fixture": route,
            },
          },
          (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () =>
              resolve({
                status: response.statusCode,
                value: JSON.parse(Buffer.concat(chunks).toString()),
              }),
            );
            response.on("error", reject);
          },
        );
        request.on("error", reject);
        request.write(bytes.slice(0, 1));
      });
      outcome.catch(() => {});
      pending.push(request);
      await bounded(admitted, "partial request did not enter real server");
      return { finish: () => request.end(bytes.slice(1)), outcome };
    };
    const oldMCP = await start(
      "/mcp",
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { Authorization: "Bearer " + grant.value.token },
    );
    const oldOwner = await start("/api/mcp/config", config, {
      "x-local-token": app.token,
    });
    assert.equal(
      (await owner("/api/mcp/config", { ...config, enabled: false })).status,
      200,
    );
    oldMCP.finish();
    oldOwner.finish();
    assert.equal(
      (await bounded(oldMCP.outcome, "old MCP body did not settle")).status,
      403,
    );
    assert.equal(
      (await bounded(oldOwner.outcome, "old owner body did not settle")).status,
      400,
    );
    assert.equal(
      JSON.parse(await readFile(path.join(root, ".mcp-config.json"), "utf8"))
        .enabled,
      false,
    );
  },
);
