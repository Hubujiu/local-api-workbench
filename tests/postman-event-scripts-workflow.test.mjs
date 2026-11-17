import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { importIntoProject } from "../src/core.mjs";

// Ordinary CI only: real owner routes and loopback HTTP. Never run locally for this task.
// No database, XML, pressure, original GUI or runtime-budget changes.
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "postman-event-workflow-"));
  const seen = [];
  const peer = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const entry = {
      method: request.method,
      url: request.url,
      trace: request.headers["x-event-trace"] ?? null,
      disabled: request.headers["x-disabled"] ?? null,
      body: Buffer.concat(chunks).toString(),
    };
    seen.push(entry);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(entry));
  });
  peer.listen(0, "127.0.0.1");
  await once(peer, "listening");
  let app = await createApp({ root, port: 0 });
  t.after(async () => {
    await Promise.all([close(app.server), close(peer)]);
    await rm(root, { recursive: true, force: true });
  });
  async function response(route, data, method = "POST") {
    return fetch(app.url + "/api" + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  }
  async function api(route, data, method = "POST") {
    const res = await response(route, data, method);
    const text = await res.text();
    assert.equal(res.ok, true, text);
    return JSON.parse(text);
  }
  const project = await api("/projects", {
    name: "Postman event workflow",
  });
  project.environments = [
    { id: "selected", name: "Selected", variables: { guard: "unchanged" } },
  ];
  project.globalVariables = { globalGuard: "unchanged" };
  const route = "/projects/" + project.id;
  await api(route, project, "PUT");
  return {
    root,
    seen,
    project,
    route,
    api,
    response,
    url: `http://127.0.0.1:${peer.address().port}/events`,
    async restart() {
      await close(app.server);
      app = await createApp({ root, port: 0 });
    },
  };
}
async function diskSnapshot(directory) {
  const files = {};
  async function walk(current, prefix = "") {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const relative = prefix + entry.name;
      if (entry.isDirectory())
        await walk(path.join(current, entry.name), relative + "/");
      else {
        assert.equal(entry.isFile(), true);
        files[relative] = (
          await readFile(path.join(current, entry.name))
        ).toString("base64");
      }
    }
  }
  await walk(directory);
  return files;
}

const event = (listen, exec, extra = {}) => ({
  listen,
  script: { type: "application/javascript", exec },
  ...extra,
});
function collection(url) {
  const disabled = (listen) =>
    event(
      listen,
      [
        'pm.globals.set("globalGuard","changed-by-disabled");',
        'pm.request.headers.add({key:"X-Disabled",value:"on"});',
        `pm.sendRequest(${JSON.stringify(url + "/disabled")});`,
        'throw Error("DISABLED_SENTINEL");',
      ],
      { disabled: true },
    );
  const events = (marker, first = false) => [
    disabled("prerequest"),
    event(
      "prerequest",
      first
        ? `pm.environment.set("trace",${JSON.stringify(marker)});`
        : [
            `pm.environment.set("trace",pm.environment.get("trace")+${JSON.stringify(marker)});`,
          ],
      { disabled: false },
    ),
    disabled("test"),
    event(
      "test",
      `pm.environment.set("trace",pm.environment.get("trace")+${JSON.stringify(marker.toLowerCase())});`,
    ),
    event("test", "const invalid syntax = ;", { disabled: true }),
  ];
  return {
    info: {
      name: "Event import",
      schema:
        "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    event: events("C", true),
    item: [
      {
        name: "Folder",
        event: events("F"),
        item: [
          {
            name: "Nested",
            event: events("N"),
            item: [
              {
                name: "Leaf",
                request: { method: "GET", url },
                event: [
                  ...events("R"),
                  event(
                    "prerequest",
                    'pm.request.headers.add({key:"X-Event-Trace",value:pm.environment.get("trace")});',
                  ),
                  event("test", [
                    'pm.test("event order and wire",()=>{',
                    'pm.expect(pm.environment.get("trace")).to.equal("CFNRcfnr");',
                    'pm.expect(pm.response.json().trace).to.equal("CFNR");',
                    "pm.expect(pm.response.json().disabled).to.equal(null);",
                    'pm.expect(pm.globals.get("globalGuard")).to.equal("unchanged");',
                    "});",
                  ]),
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}
function assertRequest(request, original) {
  assert.equal(request.beforeScript, original.beforeScript);
  assert.equal(request.afterScript, original.afterScript);
  assert.equal(request.url, original.url);
  assert.equal(request.folder, "Folder/Nested");
  assert.doesNotMatch(
    request.beforeScript + request.afterScript,
    /DISABLED_SENTINEL|invalid syntax|changed-by-disabled|\/disabled/,
  );
}
function assertWire(response) {
  assert.equal(response.status, 200, JSON.stringify(response));
  const wire = JSON.parse(response.body);
  assert.equal(wire.url, "/events");
  assert.equal(wire.trace, "CFNR");
  assert.equal(wire.disabled, null);
}
function assertRun(run) {
  assert.equal(run.status, "passed", JSON.stringify(run));
  assertWire(run.results[0].response);
  assert.equal(run.variables.trace, "CFNRcfnr");
  assert.equal(run.results[0].assertions.length, 1);
  assert.equal(run.results[0].assertions[0].passed, true);
}

test("owner event import preserves active/disabled semantics through atomic rejection, freeze, restart and backup restore", async (t) => {
  const f = await fixture(t);
  const source = collection(f.url),
    sourceBefore = structuredClone(source);
  let project = await f.api(f.route + "/import", { document: source });
  assert.deepEqual(source, sourceBefore);
  const original = structuredClone(project.requests[0]);
  assertRequest(original, original);
  assert.equal(f.seen.length, 0, "import never executes scripts or HTTP");

  // Invalid second request must not retain the first, either in-memory or on disk.
  const invalidEvents = [
    [{ listen: "prerequest", disabled: "false", script: { exec: "x" } }],
    [{ listen: "test", script: { exec: ["x", 42] } }],
    [{ listen: "test", script: { src: f.url + "/source", exec: "fallback" } }],
    [{ listen: "test", script: { exec: "x", disabled: true } }],
    [
      {
        listen: "test",
        script: { exec: "x", packages: { custom: { id: "not-resolved" } } },
      },
    ],
    [{ listen: "other", script: { exec: "x" } }],
    {},
  ];
  const saved = await f.api(f.route, undefined, "GET");
  const bytes = await diskSnapshot(f.root);
  for (const events of invalidEvents) {
    const document = {
      info: source.info,
      item: [
        {
          name: "Good first",
          request: { url: f.url },
          event: [event("test", "// valid")],
        },
        { name: "Bad second", request: { url: f.url }, event: events },
      ],
    };
    const memory = structuredClone(saved),
      before = structuredClone(memory);
    assert.throws(() => importIntoProject(memory, document), /Postman/);
    assert.deepEqual(memory, before);
    const response = await f.response(f.route + "/import", { document });
    assert.equal(response.status, 400, await response.text());
    assert.deepEqual(await f.api(f.route, undefined, "GET"), saved);
    assert.deepEqual(await diskSnapshot(f.root), bytes);
  }
  const oversized = collection(f.url);
  oversized.event = [event("prerequest", "x".repeat(60000))];
  oversized.item[0].event = [event("prerequest", "y".repeat(60000))];
  const rejected = await f.response(f.route + "/import", {
    document: oversized,
  });
  assert.equal(rejected.status, 400, await rejected.text());
  assert.deepEqual(await diskSnapshot(f.root), bytes);
  assert.equal(f.seen.length, 0);

  await f.restart();
  project = await f.api(f.route, undefined, "GET");
  assertRequest(project.requests[0], original);
  const response = await f.api(f.route + "/execute", {
    request: project.requests[0],
    environmentId: "selected",
  });
  assert.equal(response.outcome, "passed", JSON.stringify(response));
  assertWire(response);
  assert.equal(response.extracted.trace, "CFNRcfnr");
  assert.equal(response.assertions.length, 1);
  assert.equal(response.assertions[0].passed, true);
  const { item } = await f.api(f.route + "/cases", {
    id: "event-case",
    name: "Frozen events",
    sourceRequestId: original.id,
    request: original,
  });
  await f.api(f.route + "/plans", {
    id: "event-plan",
    name: "Frozen events",
    environmentId: "selected",
    steps: [{ request: item.request }],
  });
  project = await f.api(f.route, undefined, "GET");
  assert.equal(
    project.environments.find((env) => env.id === "selected").variables.trace,
    "CFNRcfnr",
  );
  assert.equal(project.globalVariables.globalGuard, "unchanged");
  assertRequest(project.cases[0].request, original);
  project.requests[0].beforeScript = 'throw Error("changed live script");';
  project.requests[0].afterScript = "";
  project.requests[0].url = f.url + "/live-changed";
  await f.api(f.route, project, "PUT");
  await f.restart();
  project = await f.api(f.route, undefined, "GET");
  const caseResponse = await f.api(f.route + "/execute", {
    request: project.cases[0].request,
    environmentId: "selected",
  });
  assert.equal(caseResponse.outcome, "passed", JSON.stringify(caseResponse));
  assertWire(caseResponse);
  const run = await f.api(f.route + "/run", {
    planId: "event-plan",
    environmentId: "selected",
  });
  assertRun(run);
  assert.equal(f.seen.length, 3);

  const backup = await f.api(f.route + "/export", undefined, "GET");
  const restored = await f.api("/restore", { document: backup });
  assert.notEqual(restored.id, project.id);
  await f.restart();
  const reopened = await f.api("/projects/" + restored.id, undefined, "GET");
  assertRequest(reopened.cases[0].request, original);
  assertRequest(reopened.plans[0].steps[0].request, original);
  const storedRun = reopened.runs.find((entry) => entry.id === run.id);
  assertRun(storedRun); // Semantic evidence, not HTTP-only receipt fields.
  assert.equal(
    f.seen.length,
    3,
    "saving/restoring/restarting never replays scripts",
  );
  const rerun = await f.api("/projects/" + restored.id + "/run", {
    planId: "event-plan",
    environmentId: "selected",
  });
  assertRun(rerun);
  assert.equal(f.seen.length, 4);
  assert.equal(
    f.seen.every((entry) => entry.url === "/events" && entry.disabled === null),
    true,
  );
  const originalAfter = await f.api(f.route, undefined, "GET");
  assert.equal(
    originalAfter.runs.length,
    1,
    "restored execution stays in restored project",
  );
  assert.equal(originalAfter.globalVariables.globalGuard, "unchanged");
});
