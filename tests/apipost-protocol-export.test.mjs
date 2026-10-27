import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { importIntoProject } from "../src/core.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import { verifyProtocolDefinitions } from "../src/apipost-protocol-export.mjs";
import { nativeProtocolFixture } from "./fixtures/apipost-native-protocols.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";
const exporters = [exportApipost, exportApipostDirectory];
const blank = (id = "target") => ({
  id,
  name: id,
  requests: [],
  folders: [],
  environments: [],
  servers: [],
  settings: {},
  globalVariables: {},
  plans: [],
  createdAt: "2026-01-01T00:00:00Z",
});
function fixture(tcp = "127.0.0.1:1", sse = "http://127.0.0.1:2/events?x=one") {
  const source = modernApipostFixture();
  source.global.envs[0].env_var_list.payload = {
    value: "initial",
    current_value: "wire-value",
  };
  source.models = [
    {
      model_id: "model",
      model_type: "model",
      name: "Payload",
      schema: { type: "string" },
    },
  ];
  source.apis = source.apis.filter((n) => n.target_type === "api").slice(0, 1);
  source.apis[0].parent_id = "a";
  source.apis[0].request.pre_tasks = [];
  source.apis[0].request.post_tasks = [];
  source.apis.push(
    {
      target_id: "a",
      target_type: "folder",
      name: "A",
      parent_id: "0",
      request: {},
    },
    {
      target_id: "b",
      target_type: "folder",
      name: "B",
      parent_id: "a",
      request: {},
    },
    {
      target_id: "doc",
      target_type: "doc",
      name: "Protocol guide",
      parent_id: "a",
      description: "inert protocol notes",
    },
  );
  const nodes = nativeProtocolFixture({ tcp, sse }).apis.filter(
    (n) => n.target_type !== "websocket2",
  );
  for (const n of nodes) n.project_id = source.project_id;
  nodes[0].parent_id = "b";
  nodes[1].request.body.raw = "{{payload}}";
  nodes[1].description = "keep TCP description";
  nodes[1].response = { raw: "inert example" };
  nodes[2].request.header.parameter = [
    { key: "Accept-Language", value: "zh-CN", is_checked: 1 },
  ];
  nodes[2].parent_id = "a";
  nodes[2].request.body.raw = "{{payload}}";
  const second = structuredClone(nodes[2]);
  second.target_id = "events-two";
  second.name = "Events two";
  second.parent_id = "b";
  source.apis.push(...nodes, second);
  return source;
}
function imported(source = fixture()) {
  const p = blank();
  importIntoProject(p, source, { modelNameMode: "preserve" });
  return p;
}

test("TCP/SSE complete resource graphs roundtrip twice in JSON and directory alongside HTTP docs models and nested folders", () => {
  for (const reverse of [false, true])
    for (const exporter of exporters) {
      const source = fixture();
      if (reverse) source.apis.reverse();
      const original = JSON.stringify(source),
        p = imported(source),
        before = structuredClone(p);
      for (let generation = 0, current = p; generation < 2; generation++) {
        const document = exporter(current, { modelNameMode: "preserve" }),
          next = blank("next");
        importIntoProject(next, document, { modelNameMode: "preserve" });
        verifyProtocolDefinitions(p.protocols, next.protocols);
        assert.equal(next.requests.length, p.requests.length);
        assert.deepEqual(
          next.documents.map((d) => [d.title, d.content, d.folder]),
          p.documents.map((d) => [d.title, d.content, d.folder]),
        );
        assert.deepEqual(
          next.dictionary.map((d) => [d.name, d.schema]),
          p.dictionary.map((d) => [d.name, d.schema]),
        );
        assert.equal(next.folders.filter((f) => f === "A/B/TCP").length, 1);
        assert(
          next.settings.apipostProtocolSources.some(
            (e) => e.source.response?.raw === "inert example",
          ),
        );
        const all = next.settings.apipostProtocolSources.map((e) => e.source);
        const container = all.find((n) => n.target_type === "socket");
        assert.equal(
          all.find((n) => n.target_type === "socket_method").parent_id,
          container.target_id,
        );
        current = next;
      }
      assert.deepEqual(p, before);
      assert.equal(JSON.stringify(source), original);
    }
});

test("source-backed export rejects incomplete graphs changed wire definitions stripped credentials and WS without mutation", () => {
  const original = imported();
  const cases = [
    (p) => p.protocols.pop(),
    (p) => p.protocols.push({ ...p.protocols[0], id: "unowned" }),
    (p) => {
      p.protocols[0].message = "edited";
    },
    (p) => {
      p.protocols[0].name = "renamed";
    },
    (p) => {
      p.protocols[0].duration = 12000;
    },
    (p) => {
      p.protocols[0].port = 4567;
    },
    (p) => {
      p.protocols.find((d) => d.type === "sse").body = "edited";
    },
    (p) => {
      p.protocols.find((d) => d.type === "sse").url += "&extra=1";
    },
    (p) => {
      p.settings.apipostProtocolSources.pop();
    },
    (p) => {
      p.settings.apipostProtocolSources[0].sourceTargetId = "forged";
    },
    (p) => {
      p.settings.apipostProtocolSources[0].notes.push("custom note");
    },
    (p) => {
      p.folders = p.folders.filter((f) => f !== "A/B/TCP");
    },
  ];
  for (const mutate of cases)
    for (const exporter of exporters) {
      const p = structuredClone(original);
      mutate(p);
      const before = structuredClone(p);
      assert.throws(
        () => exporter(p, { modelNameMode: "preserve" }),
        /原生协议/,
      );
      assert.deepEqual(p, before);
    }
  for (const kind of ["header", "cookie", "auth", "websocket"]) {
    const source = fixture();
    const sse = source.apis.find((n) => n.target_type === "sse");
    if (kind === "auth")
      sse.request.auth = {
        type: "bearer",
        bearer: { key: "fictional-removed" },
      };
    else if (kind === "websocket") {
      const ws = nativeProtocolFixture({ ws: "wss://127.0.0.1:1/echo?x=one" })
        .apis[0];
      ws.project_id = source.project_id;
      source.apis.push(ws);
    } else
      sse.request[kind].parameter = [
        {
          key: kind === "header" ? "Authorization" : "session",
          value: "fictional-removed",
          is_checked: 1,
        },
      ];
    const p = imported(source);
    assert.doesNotMatch(JSON.stringify(p), /fictional-removed/);
    for (const exporter of exporters)
      assert.throws(
        () => exporter(p, { modelNameMode: "preserve" }),
        /原生协议/,
      );
  }
});

test("current ordinary folder paths remap consistently but shared source IDs remain project-scoped", () => {
  const p = imported();
  // Ordinary original folder names were never archived; preserve current paths,
  // not an invented claim that historical folder names are recoverable.
  p.folders = p.folders.map((f) => f.replace(/^A/, "Current"));
  for (const d of p.protocols) d.folder = d.folder.replace(/^A/, "Current");
  for (const exporter of exporters) {
    const next = blank();
    importIntoProject(next, exporter(p, { modelNameMode: "preserve" }));
    verifyProtocolDefinitions(p.protocols, next.protocols);
  }
  const other = fixture();
  other.project_id = "another-origin";
  other.models = [];
  other.global = { global_param: { auth: { type: "noauth" } } };
  other.apis = other.apis.filter(
    (n) => !["api", "doc"].includes(n.target_type),
  );
  for (const node of other.apis)
    if (node.project_id) node.project_id = other.project_id;
  // Same container path across distinct imported sources is ambiguous, not silently merged.
  const nonconflicting = structuredClone(other);
  nonconflicting.apis.find((n) => n.target_id === "a").name = "Other";
  const combined = imported();
  importIntoProject(combined, nonconflicting, { modelNameMode: "preserve" });
  assert.equal(combined.protocols.length, 6);
  for (const exporter of exporters) {
    const next = blank();
    importIntoProject(next, exporter(combined, { modelNameMode: "preserve" }), {
      modelNameMode: "preserve",
    });
    verifyProtocolDefinitions(combined.protocols, next.protocols);
  }
  const collision = imported();
  importIntoProject(collision, other, { modelNameMode: "preserve" });
  for (const exporter of exporters)
    assert.throws(
      () => exporter(collision, { modelNameMode: "preserve" }),
      /原生协议/,
    );
});

test(
  "owner TCP/SSE definition export import has zero network then frozen loopback execution and restart retain isolation",
  { timeout: 30000 },
  async (t) => {
    const seen = [],
      sockets = new Set();
    const tcp = net.createServer((s) => {
      sockets.add(s);
      s.on("error", () => {});
      s.on("close", () => sockets.delete(s));
      s.on("data", (b) => {
        seen.push(["tcp", b.toString()]);
        s.write(b);
      });
    });
    const httpServer = http.createServer(async (req, res) => {
      let body = "";
      for await (const b of req) body += b;
      seen.push(["sse", body]);
      assert.equal(req.headers.authorization, undefined);
      assert.equal(req.headers["accept-language"], "zh-CN");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: " + body + "\n\n");
    });
    tcp.listen(0, "127.0.0.1");
    httpServer.listen(0, "127.0.0.1");
    await Promise.all([once(tcp, "listening"), once(httpServer, "listening")]);
    const root = await mkdtemp(path.join(os.tmpdir(), "protocol-export-"));
    let app = await createApp({ root, port: 0 });
    const stop = async () => {
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
    };
    t.after(async () => {
      await stop();
      for (const s of sockets) s.destroy();
      httpServer.closeAllConnections();
      await Promise.all([
        new Promise((r) => tcp.close(r)),
        new Promise((r) => httpServer.close(r)),
      ]);
      await rm(root, { recursive: true, force: true });
    });
    const call = async (route, method = "GET", body, status = 200) => {
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
    const source = await app.store.create("source"),
      other = await app.store.create("other");
    await call(`/api/projects/${source.id}/import`, "POST", {
      document: fixture(
        `127.0.0.1:${tcp.address().port}`,
        `http://127.0.0.1:${httpServer.address().port}/events?x=one`,
      ),
      modelNameMode: "preserve",
    });
    const before = await app.store.get(source.id),
      untouched = await app.store.get(other.id);
    for (const format of ["apipost", "apipost-directory"]) {
      const count = seen.length;
      const document = await call(
        `/api/projects/${source.id}/export?format=${format}&modelNameMode=preserve`,
      );
      const target = await app.store.create(format);
      await call(`/api/projects/${target.id}/import`, "POST", {
        document,
        modelNameMode: "preserve",
      });
      const round2 = await call(
        `/api/projects/${target.id}/export?format=${format}&modelNameMode=preserve`,
      );
      const second = await app.store.create("second");
      await call(`/api/projects/${second.id}/import`, "POST", {
        document: round2,
        modelNameMode: "preserve",
      });
      assert.equal(
        seen.length,
        count,
        "both generations are definition conversion, not execution",
      );
      const saved = await app.store.get(second.id);
      verifyProtocolDefinitions(before.protocols, saved.protocols);
      const environmentId = saved.environments.find(
        (e) => e.name === "Imported",
      ).id;
      const plan = await call(`/api/projects/${second.id}/plans`, "POST", {
        name: "frozen protocols",
        environmentId,
        steps: saved.protocols.map((d) => ({
          id: d.id,
          type: "protocol",
          protocol: { definitionId: d.id, duration: 1000 },
        })),
      });
      // Protocol steps remain unsupported native flows: use backup for the plan.
      await call(
        `/api/projects/${second.id}/export?format=apipost-directory`,
        "GET",
        undefined,
        400,
      );
      const live = await app.store.get(second.id);
      for (const d of live.protocols)
        if (d.type === "tcp") {
          d.port = 1;
          d.message = "changed-live";
        } else {
          d.url = "http://127.0.0.1:1/no";
          d.body = "changed-live";
        }
      await app.store.save(live);
      const run = await call(`/api/projects/${second.id}/run`, "POST", {
        planId: plan.id,
      });
      assert.equal(run.status, "passed", JSON.stringify(run));
      assert.equal(run.recordSaved, true);
      assert.equal(run.results.length, 3);
      assert.deepEqual(
        seen.slice(count).map((r) => r[1]),
        ["wire-value", "wire-value", "wire-value"],
      );
      const backup = await call(`/api/projects/${second.id}/export`),
        restored = await call(
          "/api/restore",
          "POST",
          { document: backup },
          201,
        );
      await stop();
      app = await createApp({ root, port: 0 });
      const disk = await app.store.get(restored.id);
      assert(disk.runs.some((r) => r.id === run.id));
      assert.deepEqual(disk.plans, backup.plans);
      const rerun = await call(`/api/projects/${restored.id}/run`, "POST", {
        planId: plan.id,
      });
      assert.equal(rerun.status, "passed", JSON.stringify(rerun));
      assert.equal(rerun.recordSaved, true);
      assert.equal(seen.length, count + 6);
      assert(seen.slice(count).every((r) => r[1] === "wire-value"));
    }
    assert.deepEqual(await app.store.get(source.id), before);
    assert.deepEqual(await app.store.get(other.id), untouched);
  },
);
