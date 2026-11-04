import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { createApp } from "../src/server.mjs";
import { importIntoProject, snapshotPlan } from "../src/core.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import { verifyProtocolDefinitions } from "../src/apipost-protocol-export.mjs";
import {
  binaryExportFixture,
  expectedBinaryExportFrames,
} from "./fixtures/native-websocket-binary-export.mjs";
const exporters = [exportApipost, exportApipostDirectory];
function imported(source) {
  const project = {
    id: "target",
    name: "target",
    requests: [],
    environments: [],
    folders: [],
    settings: {},
  };
  try {
    importIntoProject(project, source);
  } catch (error) {
    throw Error(
      `IMPORT_PREREQUISITE: binary mapper not admitted; export and wire NOT reached: ${error.message}`,
      { cause: error },
    );
  }
  return project;
}
function checkFlags(project) {
  assert.equal(project.protocols[1].sendEmptyMessage, true);
  for (const d of project.protocols.slice(2)) {
    assert.equal(Object.hasOwn(d, "sendEmptyMessage"), false);
    assert.equal(Object.hasOwn(d, "templateMode"), false);
    assert.ok(["base64", "hex"].includes(d.message.encoding));
  }
}
for (const format of ["apipost", "apipost-directory"])
  test(
    `binary export owner ${format}: two generations, reopen, backup, explicit byte+flag wire`,
    { timeout: 30000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "binary-export-")),
        frames = [];
      let connections = 0;
      const peer = http.createServer(),
        wss = new WebSocketServer({ server: peer });
      wss.on("connection", (socket) => {
        connections++;
        socket.on("error", () => {});
        socket.on("message", (data, binary) => {
          frames.push({ hex: data.toString("hex"), binary });
          socket.send(data, { binary }, () => socket.close(1000, "complete"));
        });
      });
      peer.listen(0, "127.0.0.1");
      await once(peer, "listening");
      let app = await createApp({ root, port: 0 });
      async function stop() {
        app.server.closeAllConnections();
        await new Promise((r) => app.server.close(r));
      }
      t.after(async () => {
        await stop();
        for (const s of wss.clients) s.terminate();
        await new Promise((r) => wss.close(r));
        await new Promise((r) => peer.close(r));
        await rm(root, { recursive: true, force: true });
      });
      async function call(route, body, status = 200, phase = "OWNER") {
        const response = await fetch(app.url + route, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const value = await response.json();
        assert.equal(
          response.status,
          status,
          `${phase}: ${JSON.stringify(value)}`,
        );
        return value;
      }
      const source = binaryExportFixture(
          `ws://127.0.0.1:${peer.address().port}/echo?x=one`,
        ),
        original = structuredClone(source);
      const p = await app.store.create("binary source"),
        other = await app.store.create("untouched"),
        untouched = await app.store.get(other.id);
      await call(
        `/api/projects/${p.id}/import`,
        { document: source },
        200,
        "IMPORT_PREREQUISITE; export and wire NOT reached on failure",
      );
      const initial = await app.store.get(p.id);
      checkFlags(initial);
      let current = p;
      for (let generation = 0; generation < 2; generation++) {
        const document = await call(
          `/api/projects/${current.id}/export?format=${format}`,
          undefined,
          200,
          "EXPORT_PHASE",
        );
        const next = await app.store.create("generation");
        await call(
          `/api/projects/${next.id}/import`,
          { document },
          200,
          "REIMPORT_PHASE",
        );
        const saved = await app.store.get(next.id);
        verifyProtocolDefinitions(initial.protocols, saved.protocols);
        checkFlags(saved);
        assert.deepEqual(
          saved.settings.apipostProtocolSources[0].source.message,
          source.apis[0].message,
        );
        current = next;
      }
      assert.equal(connections, 0, "import/export must not connect");
      const backup = await call(`/api/projects/${current.id}/export`);
      const restored = await call("/api/restore", { document: backup }, 201);
      await stop();
      app = await createApp({ root, port: 0 });
      const reopened = await app.store.get(restored.id);
      assert.deepEqual(reopened.protocols, backup.protocols);
      assert.deepEqual(
        reopened.settings.apipostProtocolSources,
        backup.settings.apipostProtocolSources,
      );
      assert.equal(connections, 0, "restore/reopen must not connect");
      for (const definition of reopened.protocols)
        await call(`/api/projects/${restored.id}/protocol`, {
          definitionId: definition.id,
          duration: 1000,
          maxMessages: 1,
        });
      assert.deepEqual(frames, expectedBinaryExportFrames);
      assert.equal(connections, 6);
      assert.deepEqual(await app.store.get(other.id), untouched);
      assert.deepEqual(await app.store.get(p.id), initial);
      assert.deepEqual(source, original);
    },
  );

test("binary export source groups reject edits and unsafe reconstruction atomically", () => {
  const original = imported(binaryExportFixture());
  const mutations = [
    [
      "whole group deleted",
      (p) => {
        p.protocols = [];
      },
    ],
    ["single binary deleted", (p) => p.protocols.splice(2, 1)],
    [
      "source missing",
      (p) => {
        p.settings.apipostProtocolSources = [];
      },
    ],
    [
      "data edited",
      (p) => {
        p.protocols[2].message.data = "AQ==";
      },
    ],
    [
      "equivalent encoding changed",
      (p) => {
        p.protocols[2].message = { encoding: "hex", data: "00ff80c280" };
      },
    ],
    [
      "utf8 is not binary",
      (p) => {
        p.protocols[2].message = { encoding: "utf8", data: "x" };
      },
    ],
    [
      "empty binary text flag",
      (p) => {
        p.protocols[4].sendEmptyMessage = true;
      },
    ],
    [
      "binary template flag",
      (p) => {
        p.protocols[2].templateMode = "literal";
      },
    ],
    [
      "source raw disagrees",
      (p) => {
        p.settings.apipostProtocolSources[0].source.message[2].request.raw =
          "AQ==";
      },
    ],
    [
      "source tuple changed",
      (p) => {
        p.settings.apipostProtocolSources[0].sourceProjectId = "other";
      },
    ],
    [
      "group folder split",
      (p) => {
        p.folders = ["split"];
        p.protocols[2].folder = "split";
      },
    ],
    [
      "private handshake",
      (p) => {
        p.protocols[2].handshake.requiredHeaders = ["authorization"];
      },
    ],
    [
      "wss",
      (p) => {
        p.settings.apipostProtocolSources[0].source.url = "wss://127.0.0.1:1/";
      },
    ],
    ...["file", "path", "binary", "sendEmptyMessage", "templateMode"].map(
      (key) => [
        `unknown ${key}`,
        (p) => {
          p.settings.apipostProtocolSources[0].source.message[2].request[key] =
            "unexpected";
        },
      ],
    ),
    [
      "unknown encoding",
      (p) => {
        p.settings.apipostProtocolSources[0].source.message[2].request.mode =
          "binary";
      },
    ],
    [
      "hex whitespace",
      (p) => {
        p.settings.apipostProtocolSources[0].source.message[3].request.raw =
          "00 ff";
      },
    ],
    [
      "hex odd",
      (p) => {
        p.settings.apipostProtocolSources[0].source.message[3].request.raw =
          "abc";
      },
    ],
    [
      "base64 noncanonical",
      (p) => {
        p.settings.apipostProtocolSources[0].source.message[2].request.raw =
          "AB==";
      },
    ],
  ];
  for (const [name, mutate] of mutations)
    for (const exporter of exporters) {
      const p = structuredClone(original);
      mutate(p);
      const before = structuredClone(p);
      assert.throws(() => exporter(p), undefined, name);
      assert.deepEqual(p, before, name);
    }
});

test("same target/message IDs from different sources stay distinct across native binary generations", () => {
  const initial = imported(binaryExportFixture());
  importIntoProject(initial, binaryExportFixture(undefined, "second-source"));
  assert.equal(new Set(initial.protocols.map((d) => d.id)).size, 12);
  for (const exporter of exporters) {
    let current = initial;
    for (let generation = 0; generation < 2; generation++) {
      current = imported(exporter(current));
      verifyProtocolDefinitions(initial.protocols, current.protocols);
      assert.equal(current.settings.apipostProtocolSources.length, 2);
    }
  }
});

test("binary native export rejects unsaved credentials and frozen plans without reconstructing authority", () => {
  for (const kind of ["header", "cookie"]) {
    const source = binaryExportFixture();
    source.apis[0].request[kind].parameter.push({
      key: kind === "header" ? "Authorization" : "session",
      value: "synthetic-secret-not-to-restore",
      is_checked: 1,
    });
    const project = imported(source),
      before = structuredClone(project);
    assert.equal(
      JSON.stringify(project).includes("synthetic-secret-not-to-restore"),
      false,
    );
    for (const exporter of exporters)
      assert.throws(() => exporter(project), /原生协议/);
    assert.deepEqual(project, before);
  }
  const project = imported(binaryExportFixture());
  project.plans = [
    snapshotPlan({
      steps: [
        {
          type: "protocol",
          protocol: { definition: project.protocols[2], duration: 1000 },
        },
      ],
    }),
  ];
  for (const exporter of exporters) assert.throws(() => exporter(project));
  const withoutSource = structuredClone(project);
  withoutSource.plans = [];
  withoutSource.settings.apipostProtocolSources = [];
  for (const exporter of exporters)
    assert.throws(() => exporter(withoutSource), /原生协议/);
});

test("binary native export source limits and bad fields remain fail closed", () => {
  const initial = imported(binaryExportFixture());
  for (const request of [
    { mode: "base64", raw: "A".repeat(65540) },
    { mode: "hexadecimal", raw: "00".repeat(32769) },
    { mode: "base64", raw: "AA==\n" },
    { mode: "base64", raw: "AA" },
    { mode: "base64", raw: "{{payload}}" },
    { mode: "base64", raw: "AA==", flags: {} },
    { mode: "base64", raw: { encoding: "base64", data: "AA==" } },
  ])
    for (const exporter of exporters) {
      const project = structuredClone(initial);
      project.settings.apipostProtocolSources[0].source.message[2].request =
        request;
      const before = structuredClone(project);
      assert.throws(() => exporter(project));
      assert.deepEqual(project, before);
    }
});
