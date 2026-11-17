import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { importIntoProject } from "../src/core.mjs";
const examples = [
  ["text/plain; charset=utf-8", "{raw:'雪😀'}"],
  ["text/plain", ""],
  ["application/json", "false"],
  ["application/json", "0"],
];
const collection = () => ({
  info: {
    name: "Response media",
    schema:
      "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  item: [
    {
      name: "Imported examples",
      request: { method: "GET", url: "https://example.invalid/reply" },
      response: examples.map(([type, body], i) => ({
        name: `Reply ${i}`,
        code: 200,
        body,
        header: [
          { key: "cOnTeNt-TyPe", value: type },
          { key: "X-Reply", value: `safe-${i}` },
          {
            key: "Content-Type",
            value: "application/octet-stream",
            disabled: true,
          },
          { key: "Set-Cookie", value: "disabled=1", disabled: true },
        ],
      })),
    },
  ],
});
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
async function bytes(directory) {
  const output = {};
  const visit = async (relative = "") => {
    for (const entry of (
      await readdir(path.join(directory, relative), { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else
        output[name] = (await readFile(path.join(directory, name))).toString(
          "base64",
        );
    }
  };
  await visit();
  return output;
}
for (const transport of ["http", "stdio"]) {
  test(
    `Postman response media owner import, ${transport} SDK frozen consumption, OpenAPI and backup restart remain truthful and atomic`,
    { timeout: 30000 },
    async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "postman-responses-"));
      let app, client;
      const close = async () => {
        await client?.close().catch(() => {});
        client = undefined;
        if (app) {
          app.server.closeAllConnections();
          await new Promise((resolve) => app.server.close(resolve));
          app = undefined;
        }
      };
      t.after(async () => {
        await close();
        await rm(root, { recursive: true, force: true });
      });
      app = await createApp({ root, port: 0 });
      const owner = async (route, method = "GET", document, status = 200) => {
        const response = await fetch(app.url + route, {
          method,
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          body: document === undefined ? undefined : JSON.stringify(document),
        });
        const value = await response.json();
        assert.equal(response.status, status, JSON.stringify(value));
        return value;
      };
      const connect = async (ids) => {
        client = new Client(
          { name: "postman-response-fixture", version: "1" },
          { capabilities: {} },
        );
        if (transport === "http") {
          const config = await owner("/api/mcp/config", "POST", {
            enabled: true,
            projects: ids,
            write: true,
            execute: true,
            remember: false,
          });
          await client.connect(
            new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
              requestInit: {
                headers: { Authorization: "Bearer " + config.token },
              },
            }),
          );
        } else {
          await client.connect(
            new StdioClientTransport({
              command: process.execPath,
              args: [
                fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
                ...ids.flatMap((id) => ["--project", id]),
                "--write",
                "--execute",
              ],
              env: { LOCAL_API_DATA: root },
              stderr: "pipe",
            }),
          );
        }
        assert(
          (await client.listTools()).tools.some(
            (tool) => tool.name === "localapi_run_plan",
          ),
        );
      };
      const call = async (name, args) =>
        decode(await client.callTool({ name, arguments: args }));
      let project = await owner(
        "/api/projects",
        "POST",
        { name: "Postman media" },
        201,
      );
      const route = "/api/projects/" + project.id;
      const source = collection(),
        original = structuredClone(source);
      project = await owner(route + "/import", "POST", { document: source });
      assert.deepEqual(source, original);
      const api = project.requests[0];
      assert.equal(project.requests.length, 1);
      assert.deepEqual(
        api.examples.map((e) => [e.headers["content-type"], e.body]),
        examples,
      );
      assert.equal(api.examples[0].headers["x-reply"], "safe-0");
      assert.equal(Object.hasOwn(api.examples[0].headers, "set-cookie"), false);
      const checkWire = async (projectId, requestId, rows, customHeaders) => {
        for (const [i, row] of rows.entries()) {
          const sourceIndex = Number(row.name.slice("Reply ".length));
          const [type, body] = examples[sourceIndex];
          const response = await fetch(
            `${app.url}/mock/${projectId}/${requestId}?example=${i}`,
          );
          assert.equal(response.status, 200);
          assert.equal(response.headers.get("content-type"), type);
          assert.equal(await response.text(), body);
          assert.equal(
            response.headers.get("x-reply"),
            customHeaders ? `safe-${sourceIndex}` : null,
          );
          assert.equal(response.headers.get("set-cookie"), null);
          assert.equal(
            response.headers.get("x-content-type-options"),
            "nosniff",
          );
        }
        const fallback = await fetch(
          `${app.url}/mock/${projectId}/${requestId}`,
        );
        const first = examples[Number(rows[0].name.slice("Reply ".length))];
        assert.equal(fallback.headers.get("content-type"), first[0]);
        assert.equal(await fallback.text(), first[1]);
      };
      await checkWire(project.id, api.id, api.examples, true);

      // Complete conversion precedes mutation, even when a valid item comes first.
      for (const header of [
        [{ key: "Content-Type", value: "application/octet-stream" }],
        [{ key: "Content-Type", value: "application/json" }],
        [
          { key: "Content-Type", value: "text/plain" },
          { key: "content-type", value: "application/json" },
        ],
        [{ key: "Set-Cookie", value: "secret=1" }],
        [{ key: "Content-Length", value: "2" }],
        "Content-Type: text/plain\r\n",
      ]) {
        const bad = collection();
        bad.item.push({
          ...structuredClone(bad.item[0]),
          name: "invalid second",
          response: [{ code: 200, body: "x", header }],
        });
        const before = await owner(route),
          disk = await bytes(app.store.directory(project.id));
        const draft = structuredClone(before),
          sourceBefore = structuredClone(bad);
        assert.throws(() => importIntoProject(draft, bad));
        assert.deepEqual(draft, before);
        assert.deepEqual(bad, sourceBefore);
        await owner(route + "/import", "POST", { document: bad }, 400);
        assert.deepEqual(await owner(route), before);
        assert.deepEqual(await bytes(app.store.directory(project.id)), disk);
      }

      // A concrete loopback URL makes the frozen plan independent of source edits.
      project = await owner(route);
      project.requests[0].url = `${app.url}/mock/${project.id}/${api.id}`;
      project = await owner(route, "PUT", project);
      const openapi = await owner(route + "/export?format=openapi");
      let roundtrip = await owner(
        "/api/projects",
        "POST",
        { name: "OpenAPI media" },
        201,
      );
      roundtrip = await owner(`/api/projects/${roundtrip.id}/import`, "POST", {
        document: openapi,
      });
      assert.deepEqual(
        roundtrip.requests[0].examples
          .map((e) => [e.headers["content-type"], e.body])
          .sort(),
        structuredClone(examples).sort(),
      );
      // OpenAPI's current example contract preserves media/body, not arbitrary
      // response header maps. The full Workbench backup below preserves those.
      await checkWire(
        roundtrip.id,
        roundtrip.requests[0].id,
        roundtrip.requests[0].examples,
        false,
      );
      await connect([project.id, roundtrip.id]);
      assert.deepEqual(
        (
          await call("localapi_get_api_detail", {
            projectId: project.id,
            apiId: api.id,
          })
        ).examples,
        api.examples,
      );
      const beforeSDK = await owner(route),
        beforeSDKBytes = await bytes(app.store.directory(project.id));
      const unsupported = await client.callTool({
        name: "localapi_sync_openapi",
        arguments: { projectId: project.id, document: source },
      });
      assert.equal(unsupported.isError, true);
      assert.match(unsupported.content[0].text, /OpenAPI/);
      assert.deepEqual(await owner(route), beforeSDK);
      assert.deepEqual(
        await bytes(app.store.directory(project.id)),
        beforeSDKBytes,
      );
      const plan = await call("localapi_save_plan", {
        projectId: project.id,
        plan: {
          name: "Frozen media",
          statusPolicy: "strict200",
          steps: examples.map((_, i) => ({
            id: `response-${i}`,
            request: {
              ...project.requests[0],
              url: project.requests[0].url + `?example=${i}`,
            },
          })),
        },
      });
      project = await owner(route);
      project.requests[0].name = "Edited live API, not the frozen request";
      project.requests[0].url =
        "https://example.invalid/edited-live-not-executed";
      project = await owner(route, "PUT", project);
      assert.notEqual(project.requests[0].url, plan.steps[0].request.url);
      assert.deepEqual(project.plans[0], plan);
      const checkRun = (run) => {
        assert.equal(run.status, "passed");
        assert.equal(run.results.length, examples.length);
        run.results.forEach((result, i) => {
          assert.equal(result.response.body, examples[i][1]);
          assert.equal(result.response.headers["content-type"], examples[i][0]);
          assert.equal(result.response.headers["x-reply"], `safe-${i}`);
        });
      };
      const run = await call("localapi_run_plan", {
        projectId: project.id,
        planId: plan.id,
      });
      checkRun(run);
      assert.deepEqual(
        (
          await call("localapi_get_run", {
            projectId: project.id,
            runId: run.id,
          })
        ).results,
        run.results,
      );
      const backup = await owner(route + "/export");
      const copy = await owner(
        "/api/restore",
        "POST",
        { document: backup },
        201,
      );
      assert.notEqual(copy.id, project.id);
      assert.deepEqual(copy.requests, backup.requests);
      assert.deepEqual(copy.plans, backup.plans);
      assert.deepEqual(copy.runs, backup.runs);
      const port = app.server.address().port;
      await close();
      app = await createApp({ root, port });
      const restarted = await owner(route),
        restored = await owner(`/api/projects/${copy.id}`);
      assert.deepEqual(restarted.requests, backup.requests);
      assert.deepEqual(restarted.plans, backup.plans);
      assert.deepEqual(restarted.runs, backup.runs);
      assert.deepEqual(restored.requests, copy.requests);
      assert.deepEqual(restored.runs, copy.runs);
      await checkWire(
        copy.id,
        copy.requests[0].id,
        copy.requests[0].examples,
        true,
      );
      await connect([project.id, copy.id]);
      assert.deepEqual(
        (await call("localapi_get_run", { projectId: copy.id, runId: run.id }))
          .results,
        run.results,
      );
      const replay = await call("localapi_run_plan", {
        projectId: copy.id,
        planId: plan.id,
      });
      checkRun(replay);
      assert.equal(replay.planHash, run.planHash);
      assert.equal((await owner(route)).runs.length, backup.runs.length);
      assert.equal(
        (await owner(`/api/projects/${copy.id}`)).runs.length,
        copy.runs.length + 1,
      );
    },
  );
}

// Root-only composition: native response interchange is not on the feature base.
test(
  "Postman safe text/JSON examples survive both native exports, real consumption and backup restart without widening native media support",
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "postman-native-responses-"),
    );
    let app;
    const stop = async () => {
      if (!app) return;
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
      app = undefined;
    };
    t.after(async () => {
      await stop();
      await rm(root, { recursive: true, force: true });
    });
    app = await createApp({ root, port: 0 });
    const owner = async (route, method = "GET", value, status = 200) => {
      const response = await fetch(app.url + route, {
        method,
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: value === undefined ? undefined : JSON.stringify(value),
      });
      const result = await response.json();
      assert.equal(response.status, status, JSON.stringify(result));
      return result;
    };
    // The native exporter currently requires exact media names. Keep a real
    // Postman parameterized-media example to prove refusal, not silent stripping.
    let parameterized = await owner(
      "/api/projects",
      "POST",
      { name: "Parameterized media stays backed up" },
      201,
    );
    const parameterizedDocument = collection();
    parameterizedDocument.item[0].response = [
      parameterizedDocument.item[0].response[0],
    ];
    parameterized = await owner(
      `/api/projects/${parameterized.id}/import`,
      "POST",
      { document: parameterizedDocument },
    );
    const parameterizedBytes = await bytes(
      app.store.directory(parameterized.id),
    );
    for (const format of ["apipost", "apipost-directory"]) {
      const rejected = await owner(
        `/api/projects/${parameterized.id}/export?format=${format}`,
        "GET",
        undefined,
        400,
      );
      assert.match(rejected.error, /Content-Type/);
      assert.deepEqual(
        await owner(`/api/projects/${parameterized.id}`),
        parameterized,
      );
      assert.deepEqual(
        await bytes(app.store.directory(parameterized.id)),
        parameterizedBytes,
      );
    }
    assert.deepEqual(
      (await owner(`/api/projects/${parameterized.id}/export`)).requests,
      parameterized.requests,
    );

    const document = collection();
    document.item[0].response = [
      document.item[0].response[0],
      document.item[0].response[2],
    ];
    document.item[0].response[0].header[0].value = "text/plain";
    let source = await owner(
      "/api/projects",
      "POST",
      { name: "Native-supported Postman media" },
      201,
    );
    source = await owner(`/api/projects/${source.id}/import`, "POST", {
      document,
    });
    const expected = source.requests[0].examples.map(
      ({ name, status, headers, body }) => ({ name, status, headers, body }),
    );
    const signature = (request) =>
      request.examples.map(({ name, status, headers, body }) => ({
        name,
        status,
        headers,
        body,
      }));
    const wire = async (project) => {
      const request = project.requests[0];
      assert.deepEqual(signature(request), expected);
      for (const [index, example] of expected.entries()) {
        const response = await fetch(
          `${app.url}/mock/${project.id}/${request.id}?example=${index}`,
        );
        assert.equal(response.status, example.status);
        assert.equal(
          response.headers.get("content-type"),
          example.headers["content-type"],
        );
        assert.equal(
          response.headers.get("x-reply"),
          example.headers["x-reply"],
        );
        assert.equal(response.headers.get("set-cookie"), null);
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");
        assert.equal(await response.text(), example.body);
      }
    };
    const checkRun = (run) => {
      assert.equal(run.status, "passed");
      assert.equal(run.results.length, expected.length);
      run.results.forEach((result, index) => {
        assert.equal(result.response.body, expected[index].body);
        assert.equal(
          result.response.headers["content-type"],
          expected[index].headers["content-type"],
        );
        assert.equal(
          result.response.headers["x-reply"],
          expected[index].headers["x-reply"],
        );
      });
    };
    await wire(source);
    const saved = [];
    for (const format of ["apipost", "apipost-directory"]) {
      const sourceBytes = await bytes(app.store.directory(source.id));
      const exported = await owner(
        `/api/projects/${source.id}/export?format=${format}`,
      );
      assert.deepEqual(await owner(`/api/projects/${source.id}`), source);
      assert.deepEqual(
        await bytes(app.store.directory(source.id)),
        sourceBytes,
      );
      let target = await owner(
        "/api/projects",
        "POST",
        { name: format + " imported Postman responses" },
        201,
      );
      target = await owner(`/api/projects/${target.id}/import`, "POST", {
        document: exported,
      });
      await wire(target);
      const plan = await owner(`/api/projects/${target.id}/plans`, "POST", {
        name: "Frozen native response consumer",
        statusPolicy: "strict200",
        steps: expected.map((_, index) => ({
          id: `native-response-${index}`,
          request: {
            name: `Consume ${index}`,
            method: "GET",
            url: `${app.url}/mock/${target.id}/${target.requests[0].id}?example=${index}`,
          },
        })),
      });
      const run = await owner(`/api/projects/${target.id}/run`, "POST", {
        planId: plan.id,
      });
      checkRun(run);
      const backup = await owner(`/api/projects/${target.id}/export`);
      const copy = await owner(
        "/api/restore",
        "POST",
        { document: backup },
        201,
      );
      assert.deepEqual(copy.requests, backup.requests);
      assert.deepEqual(copy.plans, backup.plans);
      assert.deepEqual(copy.runs, backup.runs);
      saved.push({ targetId: target.id, copyId: copy.id, backup, plan, run });
    }
    const port = app.server.address().port;
    await stop();
    app = await createApp({ root, port });
    for (const { targetId, copyId, backup, plan, run } of saved) {
      const target = await owner(`/api/projects/${targetId}`),
        copy = await owner(`/api/projects/${copyId}`);
      assert.deepEqual(target.requests, backup.requests);
      assert.deepEqual(target.runs, backup.runs);
      assert.deepEqual(copy.requests, backup.requests);
      assert.deepEqual(copy.plans, backup.plans);
      assert.deepEqual(copy.runs, backup.runs);
      await wire(copy);
      // Restored frozen URLs intentionally still name the retained target.
      const next = await owner(`/api/projects/${copyId}/run`, "POST", {
        planId: plan.id,
      });
      checkRun(next);
      assert.equal(next.planHash, run.planHash);
      assert.equal(
        (await owner(`/api/projects/${targetId}`)).runs.length,
        backup.runs.length,
      );
      assert.equal(
        (await owner(`/api/projects/${copyId}`)).runs.length,
        backup.runs.length + 1,
      );
    }
  },
);
