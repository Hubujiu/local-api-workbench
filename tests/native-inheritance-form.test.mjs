import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { importIntoProject, restoreProject } from "../src/core.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import { nativeInheritanceFixture } from "./fixtures/native-inheritance.mjs";
const row = (key, value, is_checked = 1) => ({ key, value, is_checked });
function source(url, mode) {
  const d = nativeInheritanceFixture();
  d.global.envs[0].server_list[0].uri = url;
  d.global.envs[0].env_var_list.token = {
    value: "fictional",
    current_value: "fictional",
  };
  d.global.global_param.body = {
    parameter: [
      row("shared", "project"),
      row("unicode", "雪😀"),
      row("empty", ""),
    ],
  };
  d.apis[0].request.body = {
    parameter: [row("shared", "folder"), row("folder", "{{id}}")],
  };
  const child = {
    ...structuredClone(d.apis[0]),
    target_id: "child",
    parent_id: "folder",
    name: "Child",
    request: {
      auth: { type: "inherit" },
      body: { parameter: [row("nested", "深层")] },
    },
  };
  d.apis.splice(1, 0, child);
  d.apis[2].parent_id = "child";
  d.apis[2].method = "POST";
  d.apis[2].request.body = {
    mode,
    parameter: [row("shared", "disabled", 0), row("own", "a+b &= 雪")],
  };
  return d;
}
const close = (server) =>
  new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
const decode = (r) => {
  assert.notEqual(r.isError, true, r.content?.[0]?.text);
  return JSON.parse(r.content[0].text);
};
function cli(root, p, plan) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/run-plan.mjs", import.meta.url)),
        "--project",
        p,
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
      problem;
    const timer = setTimeout(() => {
      problem = Error("CLI deadline");
      proc.kill();
    }, 15000);
    proc.stdout.on("data", (c) => {
      out += c;
      if (Buffer.byteLength(out) > 2 * 1024 * 1024) {
        problem = Error("CLI output cap");
        proc.kill();
      }
    });
    proc.stderr.on("data", (c) => {
      err += c;
      if (Buffer.byteLength(err) > 16384) {
        problem = Error("CLI stderr cap");
        proc.kill();
      }
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (problem) return reject(problem);
      try {
        assert.equal(code, 0, err + out);
        resolve(JSON.parse(out));
      } catch (e) {
        reject(e);
      }
    });
  });
}
for (const mode of ["urlencoded", "form-data"])
  for (const directory of [false, true])
    test(
      `preserved ${mode} ${directory ? "directory" : "JSON"} form graph roundtrip executes live/frozen and restores`,
      { timeout: 45000 },
      async (t) => {
        const root = await mkdtemp(path.join(tmpdir(), "graph-form-"));
        const wire = [];
        const peer = http.createServer(async (req, res) => {
          let body = "";
          for await (const c of req) body += c;
          let fields;
          if (mode === "urlencoded") {
            assert.equal(
              req.headers["content-type"],
              "application/x-www-form-urlencoded",
            );
            fields = [...new URLSearchParams(body)];
          } else {
            const match = /^multipart\/form-data; boundary=([^;]+)$/.exec(
              req.headers["content-type"],
            );
            assert(match);
            const boundary = match[1];
            assert(body.endsWith("--" + boundary + "--\r\n"));
            fields = body
              .split("--" + boundary + "\r\n")
              .slice(1)
              .map((x) => {
                const m =
                  /^Content-Disposition: form-data; name="([^"]+)"\r\n\r\n([\s\S]*?)\r\n(?:--|$)/.exec(
                    x,
                  );
                assert(m, x);
                return [m[1], m[2]];
              });
          }
          wire.push({ body, fields });
          res.setHeader("content-type", "application/json");
          res.end('{"ok":true}');
        });
        await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
        let app = await createApp({ root, port: 0 });
        let client;
        t.after(async () => {
          await client?.close().catch(() => {});
          await close(app.server);
          await close(peer);
          await rm(root, { recursive: true, force: true });
        });
        async function owner(id, route, data, status = 200) {
          const r = await fetch(app.url + "/api/projects/" + id + "/" + route, {
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
        }
        const d = source(`http://127.0.0.1:${peer.address().port}`, mode),
          original = structuredClone(d);
        let p = await app.store.create("first");
        importIntoProject(p, d, { inheritanceMode: "preserve" });
        await app.store.save(p);
        const origin = await app.store.get(p.id);
        const other = await app.store.create("other"),
          otherBefore = await app.store.get(other.id);
        for (let i = 0; i < 2; i++) {
          const exported = directory
            ? exportApipostDirectory(p)
            : exportApipost(p);
          const target = await app.store.create("generation" + i);
          importIntoProject(target, exported, { inheritanceMode: "preserve" });
          await app.store.save(target);
          assert.deepEqual(
            target.settings.nativeInheritance.projectLayer,
            p.settings.nativeInheritance.projectLayer,
          );
          assert.deepEqual(
            target.settings.nativeInheritance.folders.map((f) => ({
              path: f.path,
              layer: f.layer,
            })),
            p.settings.nativeInheritance.folders.map((f) => ({
              path: f.path,
              layer: f.layer,
            })),
          );
          assert.deepEqual(target.requests[0].form, p.requests[0].form);
          assert.equal(target.requests[0].bodyType, mode);
          p = target;
        }
        assert.deepEqual(d, original);
        assert.equal(wire.length, 0);
        const check = (shared = "folder") => {
          const f = Object.fromEntries(wire.at(-1).fields);
          assert.deepEqual(f, {
            unicode: "雪😀",
            empty: "",
            shared,
            folder: "43",
            nested: "深层",
            own: "a+b &= 雪",
          });
          assert.equal(
            wire.at(-1).fields.filter((x) => x[0] === "shared").length,
            1,
          );
          assert(!wire.at(-1).body.includes("disabled"));
        };
        await owner(p.id, "execute", { request: p.requests[0] });
        check();
        const plan = await owner(p.id, "plans", {
          name: "Frozen",
          environmentId: p.environments[0].id,
          steps: [{ request: p.requests[0] }],
        });
        const item = (
          await owner(p.id, "cases", {
            name: "Frozen case",
            sourceRequestId: p.requests[0].id,
            request: p.requests[0],
          })
        ).item;
        p = await app.store.get(p.id);
        p.settings.nativeInheritance.folders.find(
          (f) => f.path === "Group",
        ).layer.form[0].value = "changed";
        await app.store.save(p);
        await owner(p.id, "execute", { request: p.requests[0] });
        check("changed");
        await owner(p.id, "execute", { request: item.request });
        check();
        await owner(p.id, "run", { planId: plan.id });
        check();
        const config = await fetch(app.url + "/api/mcp/config", {
          method: "POST",
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            enabled: true,
            projects: [p.id],
            write: true,
            execute: true,
            remember: false,
          }),
        });
        const { token } = await config.json();
        client = new Client(
          { name: "form-graph-test", version: "1" },
          { capabilities: {} },
        );
        await client.connect(
          new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
            requestInit: { headers: { authorization: "Bearer " + token } },
          }),
        );
        const count = wire.length,
          before = await app.store.get(p.id);
        for (const name of [
          "localapi_execute_api",
          "apipost_create_execution_flow",
        ]) {
          const args = name.startsWith("localapi")
            ? {
                projectId: p.id,
                apiId: p.requests[0].id,
                input: { body: { shared: "ambiguous" } },
              }
            : {
                project_id: p.id,
                name: "Rejected",
                steps: [
                  {
                    target_id: p.requests[0].id,
                    input: { body: { shared: "ambiguous" } },
                  },
                ],
              };
          const r = await client.callTool({ name, arguments: args });
          assert.equal(r.isError, true);
          assert.match(r.content[0].text, /同名多行/);
        }
        assert.equal(wire.length, count);
        assert.deepEqual((await app.store.get(p.id)).plans, before.plans);
        decode(
          await client.callTool({
            name: "localapi_execute_api",
            arguments: { projectId: p.id, apiId: p.requests[0].id },
          }),
        );
        check("changed");
        const native = decode(
          await client.callTool({
            name: "apipost_create_execution_flow",
            arguments: {
              project_id: p.id,
              name: "Unique form input",
              steps: [
                {
                  target_id: p.requests[0].id,
                  input: { body: { own: "frozen-override" } },
                },
              ],
            },
          }),
        );
        const plansBefore = (await app.store.get(p.id)).plans;
        const updated = await client.callTool({
          name: "apipost_update_execution_flow",
          arguments: {
            project_id: p.id,
            flow_id: native.flow_id,
            steps: [
              {
                target_id: p.requests[0].id,
                step_id: plansBefore.find((x) => x.id === native.flow_id)
                  .steps[0].id,
                input: { body: { shared: "ambiguous" } },
              },
            ],
          },
        });
        assert.equal(updated.isError, true);
        assert.match(updated.content[0].text, /同名多行/);
        assert.deepEqual((await app.store.get(p.id)).plans, plansBefore);
        decode(
          await client.callTool({
            name: "localapi_execute_api",
            arguments: {
              projectId: p.id,
              apiId: p.requests[0].id,
              input: { body: { own: "temporary" } },
            },
          }),
        );
        assert.equal(Object.fromEntries(wire.at(-1).fields).own, "temporary");
        assert.equal(Object.fromEntries(wire.at(-1).fields).shared, "changed");
        assert.deepEqual((await app.store.get(p.id)).requests, before.requests);
        await client.close();
        client = null;
        const stored = await app.store.get(p.id);
        const restored = restoreProject(stored);
        await app.store.save(restored);
        await close(app.server);
        app = await createApp({ root, port: 0 });
        const disk = await new Store(root).get(restored.id);
        assert.deepEqual(
          disk.settings.nativeInheritance,
          stored.settings.nativeInheritance,
        );
        const run = await cli(root, restored.id, disk.plans[0].id);
        assert.equal(run.status, "passed");
        check();
        await owner(restored.id, "execute", { request: disk.cases[0].request });
        check();
        assert.equal(wire.length, 8);
        assert.deepEqual(await app.store.get(origin.id), origin);
        assert.deepEqual(await app.store.get(other.id), otherBefore);
      },
    );

test(
  "form graph rejects unsupported source and edited modes atomically while old v1 graphs survive",
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "graph-form-reject-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = new Store(root);
    for (const mutate of [
      (d) => {
        d.global.global_param.body.raw = "raw";
      },
      (d) => {
        d.global.global_param.body.parameter[0].type = "file";
      },
      (d) => {
        d.global.global_param.body.parameter[0].field_type = "file";
      },
      (d) => {
        d.global.global_param.body.parameter[0].field_type = "FILE";
      },
      (d) => {
        d.global.global_param.body.parameter[0].content_type = "text/plain";
      },
      (d) => {
        d.apis[2].request.body.mode = "none";
      },
      (d) => {
        d.apis[2].request.body = { mode: "json", raw: "{}" };
      },
      (d) => {
        d.apis[2].method = "GET";
      },
      (d) => {
        d.global.global_param.header.parameter.push(
          row("Content-Type", "text/plain"),
        );
      },
      (d) => {
        d.global.global_param.body.parameter.push(row("shared", "duplicate"));
      },
      (d) => {
        d.global.global_param.body.parameter[0].key = 'quoted"name';
      },
    ]) {
      const p = await store.create("reject"),
        before = structuredClone(p),
        d = source("http://127.0.0.1:1", "urlencoded");
      mutate(d);
      assert.throws(() =>
        importIntoProject(p, d, { inheritanceMode: "preserve" }),
      );
      assert.deepEqual(p, before);
      assert.equal((await store.get(p.id)).requests.length, 0);
    }
    const multipart = source("http://127.0.0.1:1", "form-data");
    multipart.apis[2].request.header.parameter.push(
      row("Content-Type", "multipart/form-data"),
    );
    const p = await store.create("ct");
    assert.throws(() =>
      importIntoProject(p, multipart, { inheritanceMode: "preserve" }),
    );
    const editable = await store.create("editable");
    importIntoProject(editable, source("http://127.0.0.1:1", "urlencoded"), {
      inheritanceMode: "preserve",
    });
    await store.save(editable);
    const stable = await store.get(editable.id);
    for (const change of [
      (x) => {
        x.requests[0].bodyType = "none";
      },
      (x) => {
        x.requests[0].method = "GET";
      },
      (x) => {
        x.requests[0].headers.push({
          key: "Content-Type",
          value: "text/plain",
        });
      },
      (x) => {
        x.settings.nativeInheritance.projectLayer.form[0].type = "file";
      },
    ]) {
      const bad = structuredClone(stable);
      change(bad);
      await assert.rejects(store.save(bad));
      assert.deepEqual(await store.get(editable.id), stable);
    }
    const old = await store.create("old");
    importIntoProject(old, nativeInheritanceFixture(), {
      inheritanceMode: "preserve",
    });
    delete old.settings.nativeInheritance.projectLayer.form;
    for (const f of old.settings.nativeInheritance.folders) delete f.layer.form;
    await store.save(old);
    const before = await store.get(old.id);
    for (const exp of [exportApipost, exportApipostDirectory]) {
      const target = await store.create("old-copy");
      importIntoProject(target, exp(before), { inheritanceMode: "preserve" });
      await store.save(target);
      assert.deepEqual(target.settings.nativeInheritance.projectLayer.form, []);
    }
    assert.deepEqual(await store.get(old.id), before);
  },
);
