// Ordinary CI only. Do not run this application/transport fixture locally.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import {
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { protocolEvidenceHash } from "../src/wire-evidence.mjs";
import { Store } from "../src/runtime.mjs";
import { ProjectCommitUncertain } from "../src/project-commit-outcome.mjs";
import { nativeProtocolExportFixture } from "./fixtures/native-protocol-export.mjs";

const runFile = promisify(execFile),
  frame = Buffer.from("aa00ff0d0a", "hex"),
  tail = Buffer.from("1020300d0a", "hex");
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
async function bytes(dir) {
  const values = {};
  async function visit(current, prefix = "") {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory())
        await visit(path.join(current, entry.name), name + "/");
      else
        values[name] = (
          await readFile(path.join(current, entry.name))
        ).toString("base64");
    }
  }
  await visit(dir);
  return values;
}
async function until(predicate) {
  const end = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= end)
      throw Error("TCP delimiter fixture observation deadline");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "tcp-delimiter-")),
    sockets = new Set(),
    timers = new Set(),
    clients = [],
    seen = [],
    consumed = [],
    pending = [];
  let app,
    acceptedConnections = 0;
  const peer = net.createServer((socket) => {
    acceptedConnections++;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let command = "",
      handled = false;
    socket.on("data", (data) => {
      if (handled) return;
      command += data.toString();
      if (!command.endsWith("\n")) return;
      handled = true;
      command = command.slice(0, -1);
      seen.push(command);
      if (command === "split") {
        socket.write(frame.subarray(0, -1));
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (!socket.destroyed) socket.write(frame.subarray(-1));
        }, 40);
        timers.add(timer);
      } else if (command === "tail") socket.write(Buffer.concat([frame, tail]));
      else if (command === "eof") socket.end(frame.subarray(0, -1));
      else if (command === "empty") socket.end();
      else if (["timeout", "cancel"].includes(command))
        socket.write(frame.subarray(0, -1));
      else if (command === "plain") socket.end("legacy");
      else if (command !== "zero-timeout") socket.destroy();
    });
  });
  const consumer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    consumed.push(Buffer.concat(chunks).toString());
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ received: consumed.at(-1) }));
  });
  t.after(async () => {
    if (app) {
      for (const item of pending)
        await fetch(app.url + "/api/cancel", {
          method: "POST",
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          body: JSON.stringify({ id: item.id }),
        }).catch(() => {});
      await Promise.allSettled(pending.map((item) => item.promise));
    }
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    app?.server.closeAllConnections();
    consumer.closeAllConnections();
    await Promise.all(
      [peer, consumer, app?.server]
        .filter(Boolean)
        .map((server) => new Promise((resolve) => server.close(resolve))),
    );
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all(
    [peer, consumer].map(
      (server) =>
        new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)),
    ),
  );
  app = await createApp({ root, port: 0 });
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
  return {
    root,
    seen,
    consumed,
    pending,
    owner,
    get app() {
      return app;
    },
    get acceptedConnections() {
      return acceptedConnections;
    },
    definition: {
      id: "framed",
      name: "Binary delimiter",
      type: "tcp",
      url: "127.0.0.1",
      port: peer.address().port,
      message: "split\n",
      completion: "delimiter",
      delimiterHex: "0D0A",
      duration: 1000,
    },
    consume: {
      method: "POST",
      url: `http://127.0.0.1:${consumer.address().port}/consume`,
      bodyType: "raw",
      body: "{{tcp_frame}}",
    },
    async restart() {
      await Promise.all(
        clients.map((client) => client.close().catch(() => {})),
      );
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
      app = await createApp({ root, port: 0 });
    },
    async connect(projectId, mode, execute = true) {
      const client = new Client(
        { name: "tcp-delimiter-" + mode, version: "1" },
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
      assert(tools.some((tool) => tool.name === "localapi_get_protocol_run"));
      assert.equal(
        tools.some((tool) => tool.name === "localapi_execute_flow"),
        execute,
      );
      return (name, args) =>
        client.callTool({
          name: "localapi_" + name,
          arguments: { projectId, ...args },
        });
    },
  };
}
function checkFrame(result) {
  assert.equal(result.base64, frame.toString("base64"));
  assert.equal(result.size, frame.length);
  assert.equal(result.partial, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.framing.matched, true);
  const observedTail = Buffer.from(result.framing.trailingBase64, "base64");
  assert.equal(result.framing.trailingSize, observedTail.length);
  // TCP write() does not promise a single data callback. Exact same-chunk tail
  // retention is independently locked by the pure matcher, not this OS assumption.
  assert.deepEqual(observedTail, tail.subarray(0, observedTail.length));
}

for (const mode of ["http", "stdio"])
  test(
    `TCP delimiter owner -> ${mode} SDK frozen consumer -> CLI -> backup restart retains exact frame evidence and failure isolation`,
    { timeout: 30000 },
    async (t) => {
      const f = await fixture(t),
        p = await f.app.store.create("Delimiter lifecycle"),
        other = await f.app.store.create("Other project");
      const otherBytes = await bytes(f.app.store.directory(other.id));
      p.protocols = [f.definition];
      await f.owner(`/api/projects/${p.id}`, "PUT", p);
      let current = await f.owner(`/api/projects/${p.id}`);
      assert.equal(current.protocols[0].delimiterHex, "0d0a");
      const beforeInvalid = await bytes(f.app.store.directory(p.id));
      for (const patch of [
        { completion: "delimiter", delimiterHex: "" },
        { completion: "end", delimiterHex: "0a" },
        { completion: "delimiter", delimiterHex: "0" },
      ]) {
        const candidate = structuredClone(current);
        Object.assign(candidate.protocols[0], patch);
        await f.owner(`/api/projects/${p.id}`, "PUT", candidate, 400);
        assert.deepEqual(
          await bytes(f.app.store.directory(p.id)),
          beforeInvalid,
        );
      }
      for (const patch of [{ delimiterHex: "00" }, { completion: "end" }])
        await f.owner(
          `/api/projects/${p.id}/protocol`,
          "POST",
          { definitionId: "framed", ...patch },
          400,
        );
      const { duration: _duration, ...interactive } = f.definition;
      for (const input of [
        { definitionId: "framed" },
        { ...interactive, host: f.definition.url },
      ])
        assert.match(
          JSON.stringify(
            await f.owner(
              `/api/projects/${p.id}/protocol-sessions`,
              "POST",
              input,
              400,
            ),
          ),
          /delimiter.*交互会话/,
        );
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(
        f.acceptedConnections,
        0,
        "rejected calls open no TCP connection, including silent interactive sessions",
      );
      assert.deepEqual(f.seen, []);
      assert.deepEqual(await bytes(f.app.store.directory(p.id)), beforeInvalid);
      const direct = await f.owner(`/api/projects/${p.id}/protocol`, "POST", {
        definitionId: "framed",
      });
      checkFrame(direct);
      assert.equal(direct.recordSaved, true);
      assert.equal(typeof direct.recordId, "string");
      const call = await f.connect(p.id, mode);
      const record = decode(
        await call("get_protocol_run", { recordId: direct.recordId }),
      );
      checkFrame(record.result);
      assert.equal(record.status, "completed");
      assert.equal(record.definition.delimiterHex, "0d0a");
      const plan = decode(
        await call("save_plan", {
          plan: {
            id: "delimiter-plan",
            name: "Delimiter into HTTP",
            steps: [
              {
                id: "wire",
                type: "protocol",
                protocol: { definitionId: "framed", message: "tail\n" },
                extract: [{ name: "tcp_frame", path: "$.base64" }],
              },
              { id: "consume", request: f.consume },
            ],
          },
        }),
      );
      assert.equal(plan.steps[0].protocol.definition.delimiterHex, "0d0a");
      const first = decode(await call("execute_flow", { planId: plan.id }));
      const checkRun = (run) => {
        assert.equal(run.status, "passed", JSON.stringify(run.results));
        assert.equal(run.recordSaved, true);
        assert.equal(run.results.length, 2);
        checkFrame(run.results[0].protocolResult.result);
        assert.equal(run.results[0].protocolResult.status, "completed");
        assert.equal(
          JSON.parse(run.results[1].response.body).received,
          frame.toString("base64"),
        );
      };
      checkRun(first);
      current = await f.owner(`/api/projects/${p.id}`);
      Object.assign(current.protocols[0], {
        completion: "first-data",
        port: 1,
        message: "live-edited\n",
      });
      delete current.protocols[0].delimiterHex;
      await f.owner(`/api/projects/${p.id}`, "PUT", current);
      const second = decode(await call("execute_flow", { planId: plan.id }));
      checkRun(second);
      assert.equal(second.planHash, first.planHash);
      assert.deepEqual(second.snapshot, first.snapshot);
      const source = await f.owner(`/api/projects/${p.id}`),
        sourceBytes = await bytes(f.app.store.directory(p.id));
      const backup = await f.owner(`/api/projects/${p.id}/export`);
      const corrupt = structuredClone(backup),
        damaged = corrupt.protocolRuns.find(
          (item) => item.id === direct.recordId,
        ),
        projectsBefore = await f.owner("/api/projects");
      damaged.result.framing.matched = false;
      damaged.result.partial = true;
      damaged.status = "partial";
      damaged.resultHash = protocolEvidenceHash(damaged.result);
      assert.match(
        JSON.stringify(
          await f.owner("/api/restore", "POST", { document: corrupt }, 400),
        ),
        /TCP 结束标记证据无效/,
      );
      assert.deepEqual(await f.owner("/api/projects"), projectsBefore);
      assert.deepEqual(await bytes(f.app.store.directory(p.id)), sourceBytes);
      const restored = await f.owner(
        "/api/restore",
        "POST",
        { document: backup },
        201,
      );
      assert.deepEqual(restored.protocolRuns, source.protocolRuns);
      assert.deepEqual(restored.runs, source.runs);
      const sent = f.seen.length;
      await f.restart();
      const recovered = await f.owner(`/api/projects/${restored.id}`);
      assert.deepEqual(recovered.plans, source.plans);
      assert.deepEqual(recovered.protocolRuns, source.protocolRuns);
      assert.deepEqual(recovered.runs, source.runs);
      assert.equal(f.seen.length, sent, "restore/restart cannot replay TCP");
      const read = await f.connect(restored.id, mode, false);
      assert.deepEqual(
        decode(await read("get_protocol_run", { recordId: direct.recordId })),
        record,
      );
      assert.deepEqual(
        decode(await read("get_execution_result", { runId: first.id })),
        source.runs.find((run) => run.id === first.id),
      );
      assert.equal(
        (
          await read("get_protocol_run", {
            projectId: p.id,
            recordId: direct.recordId,
          })
        ).isError,
        true,
      );
      const cli = await runFile(
        process.execPath,
        [
          fileURLToPath(new URL("../scripts/run-plan.mjs", import.meta.url)),
          "--project",
          restored.id,
          "--plan",
          plan.id,
        ],
        {
          env: { ...process.env, LOCAL_API_DATA: f.root },
          timeout: 10000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      const cliRun = JSON.parse(cli.stdout);
      checkRun(cliRun);
      assert.equal(cliRun.planHash, first.planHash);
      assert.deepEqual(cliRun.snapshot, first.snapshot);
      assert.deepEqual(await bytes(f.app.store.directory(p.id)), sourceBytes);
      assert.deepEqual(
        await bytes(f.app.store.directory(other.id)),
        otherBytes,
      );
      assert(f.consumed.every((body) => body === frame.toString("base64")));
      assert.equal(f.consumed.length, 3);
      // Feature receipt is the existing standalone protocol contract, not a
      // fabricated successful append or a root-only typed uncertainty promise.
      const beforeFailure = await bytes(f.app.store.directory(restored.id)),
        count = f.seen.length,
        append = f.app.store.append;
      f.app.store.append = async () => {
        throw Error("fixture record storage rejected");
      };
      let failed;
      try {
        failed = await f.owner(
          `/api/projects/${restored.id}/protocol`,
          "POST",
          { ...f.definition, host: f.definition.url, message: "tail\n" },
        );
      } finally {
        f.app.store.append = append;
      }
      checkFrame(failed);
      assert.equal(failed.recordSaved, false);
      assert.equal(failed.recordId, null);
      assert.equal(typeof failed.persistenceError, "string");
      assert.equal(
        f.seen.length,
        count + 1,
        "failed recording never replays TCP",
      );
      assert.deepEqual(
        await bytes(f.app.store.directory(restored.id)),
        beforeFailure,
      );
    },
  );

test(
  "TCP delimiter EOF/deadline incomplete evidence, cancellation and legacy completion remain distinct without replay",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      p = await f.app.store.create("Delimiter boundaries");
    p.protocols = [f.definition];
    await f.owner(`/api/projects/${p.id}`, "PUT", p);
    for (const command of ["eof", "empty", "timeout", "zero-timeout"]) {
      const result = await f.owner(`/api/projects/${p.id}/protocol`, "POST", {
        definitionId: "framed",
        message: command + "\n",
        duration: 100,
      });
      assert.equal(result.recordSaved, true);
      assert.equal(result.partial, true);
      assert.equal(result.timedOut, command.includes("timeout"));
      assert.deepEqual(result.framing, {
        matched: false,
        trailingBase64: "",
        trailingSize: 0,
      });
      assert.equal(
        result.base64,
        ["empty", "zero-timeout"].includes(command)
          ? ""
          : frame.subarray(0, -1).toString("base64"),
      );
      const records = await f.owner(`/api/projects/${p.id}/protocol-runs`);
      assert.equal(
        records.find((record) => record.id === result.recordId).status,
        "partial",
      );
    }
    const plan = await f.owner(`/api/projects/${p.id}/plans`, "POST", {
      id: "incomplete",
      name: "Incomplete is not completed",
      steps: [
        {
          id: "wire",
          type: "protocol",
          protocol: { definitionId: "framed", message: "eof\n" },
        },
      ],
    });
    const incomplete = await f.owner(`/api/projects/${p.id}/run`, "POST", {
      planId: plan.id,
    });
    assert.equal(incomplete.status, "failed");
    assert.equal(incomplete.results[0].protocolResult.status, "partial");
    assert.equal(incomplete.recordSaved, true);
    const cancelPlan = await f.owner(`/api/projects/${p.id}/plans`, "POST", {
      id: "cancel",
      name: "Cancel before next request",
      steps: [
        {
          id: "held",
          type: "protocol",
          protocol: {
            definitionId: "framed",
            message: "cancel\n",
            duration: 10000,
          },
        },
        { id: "must-not-run", request: f.consume },
      ],
    });
    const pending = f.owner(`/api/projects/${p.id}/run`, "POST", {
      planId: cancelPlan.id,
      runId: "delimiter_cancel",
    });
    f.pending.push({ id: "delimiter_cancel", promise: pending });
    await until(() => f.seen.includes("cancel"));
    await f.owner("/api/cancel", "POST", { id: "delimiter_cancel" });
    const cancelled = await pending;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.recordSaved, true);
    assert.equal(cancelled.results.length, 1);
    assert.equal(cancelled.results[0].protocolResult.status, "cancelled");
    assert.deepEqual(f.consumed, []);
    const all = await f.owner(`/api/projects/${p.id}`);
    assert(
      all.runs.some(
        (run) => run.id === cancelled.id && run.status === "cancelled",
      ),
    );
    for (const completion of [undefined, "end", "first-data"]) {
      const result = await f.owner(`/api/projects/${p.id}/protocol`, "POST", {
        type: "tcp",
        host: f.definition.url,
        port: f.definition.port,
        message: "plain\n",
        ...(completion ? { completion } : {}),
      });
      assert.equal(result.body, "legacy");
      assert.equal(result.partial, false);
      assert.equal(result.recordSaved, true);
      assert.equal(Object.hasOwn(result, "framing"), false);
    }
    const saved = await f.owner(`/api/projects/${p.id}`),
      sent = f.seen.length;
    const restored = await f.owner(
      "/api/restore",
      "POST",
      { document: saved },
      201,
    );
    await f.restart();
    const recovered = await f.owner(`/api/projects/${restored.id}`);
    assert.deepEqual(recovered.protocolRuns, saved.protocolRuns);
    assert.deepEqual(recovered.runs, saved.runs);
    assert.equal(f.seen.length, sent);
  },
);

// Root-only intersections: this fixture is not backported to PR12's narrower base.
test(
  "root TCP delimiter source-backed and frozen-only native export rejection is atomic through owner and both SDK transports",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      p = await f.app.store.create("native delimiter boundary"),
      other = await f.app.store.create("native export isolation");
    const otherBytes = await bytes(f.app.store.directory(other.id));
    await f.owner(`/api/projects/${p.id}/import`, "POST", {
      document: nativeProtocolExportFixture(
        `${f.definition.url}:${f.definition.port}`,
      ),
      modelNameMode: "preserve",
    });
    const readers = [];
    for (const mode of ["http", "stdio"])
      readers.push(await f.connect(p.id, mode, false));
    // First prove the same source graph is supported, not an unowned definition
    // that would already be refused for an unrelated reason.
    for (const format of ["apipost", "apipost-directory"]) {
      const document = await f.owner(
        `/api/projects/${p.id}/export?format=${format}&modelNameMode=preserve`,
      );
      for (const read of readers)
        assert.deepEqual(
          decode(
            await read("export_project", { format, modelNameMode: "preserve" }),
          ).document,
          document,
        );
    }
    let current = await f.owner(`/api/projects/${p.id}`);
    const tcp = current.protocols.find(
      (definition) => definition.type === "tcp",
    );
    assert(tcp);
    tcp.completion = "delimiter";
    tcp.delimiterHex = "0d0a";
    await f.owner(`/api/projects/${p.id}`, "PUT", current);
    async function rejected(patterns) {
      const before = await f.owner(`/api/projects/${p.id}`),
        disk = await bytes(f.app.store.directory(p.id));
      for (const [format, pattern] of Object.entries(patterns)) {
        assert.match(
          JSON.stringify(
            await f.owner(
              `/api/projects/${p.id}/export?format=${format}&modelNameMode=preserve`,
              "GET",
              undefined,
              400,
            ),
          ),
          pattern,
        );
        for (const read of readers) {
          const result = await read("export_project", {
            format,
            modelNameMode: "preserve",
          });
          assert.equal(result.isError, true);
          assert.match(result.content[0].text, pattern);
        }
      }
      assert.deepEqual(await f.owner(`/api/projects/${p.id}`), before);
      assert.deepEqual(await bytes(f.app.store.directory(p.id)), disk);
    }
    await rejected({
      apipost: /原生协议导出不能无损保留修改后的定义/,
      "apipost-directory": /原生协议导出不能无损保留修改后的定义/,
    });
    const plan = await f.owner(`/api/projects/${p.id}/plans`, "POST", {
      name: "frozen delimiter without live source",
      steps: [
        { id: "wire", type: "protocol", protocol: { definitionId: tcp.id } },
      ],
    });
    current = await f.owner(`/api/projects/${p.id}`);
    current.protocols = [];
    delete current.settings.apipostProtocolSources;
    await f.owner(`/api/projects/${p.id}`, "PUT", current);
    await rejected({
      apipost: /Apipost导出尚不能表达plans/,
      "apipost-directory": /原生目录计划仅支持HTTP步骤/,
    });
    const backup = await f.owner(`/api/projects/${p.id}/export`);
    assert.equal(
      backup.plans[0].steps[0].protocol.definition.delimiterHex,
      "0d0a",
    );
    const restored = await f.owner(
      "/api/restore",
      "POST",
      { document: backup },
      201,
    );
    await f.restart();
    const recovered = await f.owner(`/api/projects/${restored.id}`);
    assert.deepEqual(recovered.plans, backup.plans);
    assert.equal(recovered.plans[0].id, plan.id);
    assert.deepEqual(recovered.protocols, []);
    assert.deepEqual(await bytes(f.app.store.directory(other.id)), otherBytes);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(f.acceptedConnections, 0);
    assert.deepEqual(f.seen, []);
    assert.deepEqual(f.consumed, []);
  },
);

test(
  "root TCP delimiter real journal uncertainty reconciles once and frozen repeat consumers survive backup restart",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      p = await f.app.store.create("delimiter uncertain receipt"),
      other = await f.app.store.create("receipt isolation");
    const otherBytes = await bytes(f.app.store.directory(other.id));
    p.protocols = [f.definition];
    await f.owner(`/api/projects/${p.id}`, "PUT", p);
    const plan = await f.owner(`/api/projects/${p.id}/plans`, "POST", {
      name: "one frame then two HTTP consumers",
      steps: [
        {
          id: "wire",
          type: "protocol",
          protocol: { definitionId: "framed" },
          extract: [{ name: "tcp_frame", path: "$.base64" }],
        },
        {
          id: "consumers",
          type: "repeat",
          count: 2,
          steps: [{ id: "consume", request: f.consume }],
        },
      ],
    });
    const edited = await f.owner(`/api/projects/${p.id}`);
    Object.assign(edited.protocols[0], {
      completion: "first-data",
      port: 1,
      message: "must-not-send\n",
    });
    delete edited.protocols[0].delimiterHex;
    await f.owner(`/api/projects/${p.id}`, "PUT", edited);
    const store = f.app.store,
      before = await store.get(p.id),
      originalSave = store.save,
      originalRead = store.readUnlocked,
      directory = store.directory(p.id),
      plans = path.join(directory, "plans"),
      kept = path.join(directory, "plans-owned-backup"),
      journalFile = path.join(directory, ".transaction.json");
    let attempts = 0,
      actualError,
      obstructed = false,
      result,
      journal;
    // Only the owned filesystem obstacle is injected; real Store.save creates
    // the journal and classifies its failure. Never fabricate a typed outcome.
    store.save = async function (candidate, options) {
      if (candidate.id !== p.id || !options?.activity)
        return originalSave.call(this, candidate, options);
      attempts++;
      this.readUnlocked = async function (key, ...args) {
        const current = await originalRead.call(this, key, ...args);
        this.readUnlocked = originalRead;
        await rename(plans, kept);
        await writeFile(plans, "delimiter-private-obstacle");
        obstructed = true;
        return current;
      };
      try {
        return await originalSave.call(this, candidate, options);
      } catch (error) {
        actualError = error;
        throw error;
      } finally {
        this.readUnlocked = originalRead;
      }
    };
    try {
      result = await f.owner(`/api/projects/${p.id}/protocol`, "POST", {
        ...f.definition,
        host: f.definition.url,
        runId: "delimiter-uncertain",
      });
      checkFrame(result);
      assert.equal(attempts, 1);
      assert(actualError instanceof ProjectCommitUncertain);
      assert.equal(actualError.projectId, p.id);
      assert.equal(result.recordSaved, false);
      assert.equal(result.recordId, null);
      assert.equal(typeof result.attemptedRecordId, "string");
      assert(result.attemptedRecordId.length > 0);
      assert.deepEqual(result.persistenceOutcome, {
        code: "PROJECT_COMMIT_UNCERTAIN",
        project_id: p.id,
        commit_outcome: "unknown",
        retry_safe: false,
      });
      for (const privateText of [
        f.root,
        "delimiter-private-obstacle",
        "ENOTDIR",
        "EISDIR",
      ])
        assert(!JSON.stringify(result).includes(privateText));
      journal = JSON.parse(await readFile(journalFile, "utf8"));
      assert.equal(journal.protocolRuns.length, 1);
      assert.equal(journal.protocolRuns[0].id, result.attemptedRecordId);
      assert.equal(journal.protocolRuns[0].runId, "delimiter-uncertain");
      assert.equal(journal.protocolRuns[0].status, "completed");
      checkFrame(journal.protocolRuns[0].result);
      assert.equal(journal.configRevision, before.configRevision);
      assert.deepEqual(journal.plans, before.plans);
      assert.deepEqual(f.seen, ["split"]);
      assert.deepEqual(f.consumed, []);
    } finally {
      store.save = originalSave;
      store.readUnlocked = originalRead;
      if (obstructed) {
        await rm(plans);
        await rename(kept, plans);
      }
    }
    const recovered = await new Store(f.root).get(p.id);
    assert.deepEqual(recovered.protocolRuns, journal.protocolRuns);
    assert.equal(recovered.configRevision, before.configRevision);
    await assert.rejects(readFile(journalFile), { code: "ENOENT" });
    const backup = await f.owner(`/api/projects/${p.id}/export`),
      restored = await f.owner(
        "/api/restore",
        "POST",
        { document: backup },
        201,
      );
    await f.restart();
    for (const mode of ["http", "stdio"]) {
      const read = await f.connect(restored.id, mode, false);
      assert.deepEqual(
        decode(
          await read("get_protocol_run", {
            recordId: result.attemptedRecordId,
          }),
        ),
        journal.protocolRuns[0],
      );
      assert.equal(
        (
          await read("get_protocol_run", {
            projectId: p.id,
            recordId: result.attemptedRecordId,
          })
        ).isError,
        true,
      );
    }
    assert.deepEqual(
      f.seen,
      ["split"],
      "recovery, reads and backup restart never retry a completed TCP effect",
    );
    const execute = await f.connect(restored.id, "http"),
      run = decode(await execute("execute_flow", { planId: plan.id }));
    assert.equal(run.status, "passed", JSON.stringify(run.results));
    assert.equal(run.recordSaved, true);
    assert.equal(run.recordId, run.id);
    assert.equal(run.attemptedRecordId, run.id);
    assert.equal(run.results.length, 3);
    checkFrame(run.results[0].protocolResult.result);
    assert.equal(
      run.snapshot.steps[0].protocol.definition.delimiterHex,
      "0d0a",
    );
    assert.equal(
      run.snapshot.steps[0].protocol.definition.port,
      f.definition.port,
    );
    assert.equal(
      new Set(run.results.slice(1).map((item) => item.repeat.occurrenceId))
        .size,
      2,
    );
    assert.deepEqual(
      run.results.slice(1).map((item) => item.repeat.iteration),
      [0, 1],
    );
    assert.deepEqual(f.consumed, [
      frame.toString("base64"),
      frame.toString("base64"),
    ]);
    assert.deepEqual(f.seen, ["split", "split"]);
    const runBackup = await f.owner(`/api/projects/${restored.id}/export`),
      second = await f.owner(
        "/api/restore",
        "POST",
        { document: runBackup },
        201,
      );
    await f.restart();
    const final = await f.owner(`/api/projects/${second.id}`);
    assert.deepEqual(final.plans, runBackup.plans);
    assert.deepEqual(final.protocolRuns, journal.protocolRuns);
    assert.deepEqual(final.runs, runBackup.runs);
    for (const mode of ["http", "stdio"]) {
      const read = await f.connect(second.id, mode, false),
        evidence = decode(
          await read("get_execution_result", { runId: run.id }),
        );
      assert.deepEqual(
        evidence,
        runBackup.runs.find((item) => item.id === run.id),
      );
      assert.equal(evidence.planHash, run.planHash);
      assert.deepEqual(evidence.snapshot, run.snapshot);
    }
    assert.deepEqual(f.seen, ["split", "split"]);
    assert.equal(f.consumed.length, 2);
    assert.deepEqual(await bytes(f.app.store.directory(other.id)), otherBytes);
  },
);
