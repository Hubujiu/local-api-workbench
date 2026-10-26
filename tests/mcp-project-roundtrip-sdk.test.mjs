import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { normalizeRequest, snapshotPlan } from "../src/core.mjs";
import { exportApipost } from "../src/apipost-export.mjs";

const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
const closeServer = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};

for (const transport of ["http", "stdio"])
  for (const format of ["apipost", "apipost-directory"])
    test(
      `official SDK ${transport} ${format} interchange is permission-scoped, atomic, persistent and execution-free`,
      { timeout: 45000 },
      async (t) => {
        const root = await mkdtemp(path.join(tmpdir(), "mcp-interchange-"));
        const wire = [];
        const upstream = http.createServer(async (request, response) => {
          let body = "";
          for await (const chunk of request) body += chunk;
          wire.push({
            url: request.url,
            method: request.method,
            body,
            authorization: request.headers.authorization,
            proof: request.headers["x-proof"],
          });
          response.setHeader("content-type", "application/json");
          response.end('{"ok":true}');
        });
        await new Promise((resolve) =>
          upstream.listen(0, "127.0.0.1", resolve),
        );
        const upstreamURL = `http://127.0.0.1:${upstream.address().port}`;
        let app =
          transport === "http" ? await createApp({ root, port: 0 }) : null;
        const store = app?.store || new Store(root);
        await store.init();
        let client;
        t.after(async () => {
          await client?.close().catch(() => {});
          if (app) await closeServer(app.server);
          await closeServer(upstream);
          await rm(root, { recursive: true, force: true });
        });

        const source = await store.create("SDK source"),
          target = await store.create("SDK merge target"),
          second = await store.create("SDK second import"),
          denied = await store.create("SDK denied"),
          archived = await store.create("SDK archived");
        archived.archived = true;
        await store.save(archived);
        source.environments[0].variables.value = "saved-value";
        source.environments[0].variableDefinitions = {
          value: { initialValue: "initial-value", description: "SDK fixture" },
        };
        const request = normalizeRequest({
          id: "sdk-saved-request",
          name: "SDK saved request",
          method: "POST",
          url: upstreamURL + "/frozen",
          bodyType: "json",
          body: '{"value":"{{value}}"}',
          auth: {
            type: "basic",
            username: "fixture",
            password: "fictional-saved-secret",
          },
          inheritSharedScripts: false,
          scriptDialect: "apipost8",
          beforeScript:
            'apt.setRequestHeader("x-proof","frozen");apt.environment.set("executed","yes");',
        });
        source.requests = [request];
        if (format === "apipost-directory")
          source.plans = [
            snapshotPlan({
              id: "sdk-frozen-plan",
              name: "SDK frozen plan",
              environmentId: source.environments[0].id,
              statusPolicy: "strict200",
              steps: [{ request }],
            }),
          ];
        await store.save(source);
        target.requests = [
          normalizeRequest({
            id: "keep-existing",
            name: "Keep existing",
            url: upstreamURL + "/keep",
          }),
        ];
        await store.save(target);
        const originalTarget = await store.get(target.id),
          originalDenied = await store.get(denied.id),
          originalArchived = await store.get(archived.id),
          originalSource = await store.get(source.id);
        const projects = [source.id, target.id, second.id, archived.id];

        const connect = async ({ write = false, execute = false } = {}) => {
          await client?.close().catch(() => {});
          client = new Client(
            { name: "project-interchange-sdk", version: "1.0.0" },
            { capabilities: {} },
          );
          if (transport === "http") {
            const configured = await fetch(app.url + "/api/mcp/config", {
              method: "POST",
              headers: {
                "x-local-token": app.token,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                enabled: true,
                projects,
                write,
                execute,
                remember: false,
              }),
            });
            assert.equal(configured.status, 200);
            const { token } = await configured.json();
            await client.connect(
              new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
                requestInit: { headers: { Authorization: "Bearer " + token } },
              }),
            );
          } else {
            await client.connect(
              new StdioClientTransport({
                command: process.execPath,
                args: [
                  fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
                  ...projects.flatMap((projectId) => ["--project", projectId]),
                  ...(write ? ["--write"] : []),
                  ...(execute ? ["--execute"] : []),
                ],
                env: { LOCAL_API_DATA: root },
                stderr: "pipe",
              }),
            );
          }
        };
        const call = (name, args = {}) =>
          client.callTool({ name: "localapi_" + name, arguments: args });
        const success = async (name, args) => decode(await call(name, args));
        const failure = async (name, args) => {
          const result = await call(name, args);
          assert.equal(result.isError, true, JSON.stringify(result));
          assert.equal(result.content[0].type, "text");
          assert(Buffer.byteLength(result.content[0].text) < 4096);
          return result;
        };

        await connect();
        let tools = (await client.listTools()).tools;
        assert(tools.some((tool) => tool.name === "localapi_export_project"));
        assert(!tools.some((tool) => tool.name === "localapi_import_project"));
        assert(!tools.some((tool) => tool.name === "localapi_run_plan"));
        const exported = await success("export_project", {
          projectId: source.id,
          format,
        });
        assert.equal(exported.projectId, source.id);
        assert.equal(exported.format, format);
        assert(exported.document && typeof exported.document === "object");
        assert.match(
          JSON.stringify(exported.document),
          /fictional-saved-secret/,
        );
        assert.deepEqual(await store.get(source.id), originalSource);
        await failure("import_project", {
          projectId: target.id,
          format,
          document: exported.document,
        });
        assert.deepEqual(await store.get(target.id), originalTarget);

        await connect({ write: true });
        tools = (await client.listTools()).tools;
        for (const name of [
          "localapi_import_project",
          "localapi_export_project",
        ]) {
          const tool = tools.find((item) => item.name === name);
          assert(tool);
          assert.equal(tool.inputSchema.additionalProperties, false);
          assert.deepEqual(tool.inputSchema.properties.format.enum, [
            "apipost",
            "apipost-directory",
          ]);
          assert(tool.inputSchema.required.includes("projectId"));
          assert(tool.inputSchema.required.includes("format"));
        }
        assert(!tools.some((tool) => tool.name === "localapi_run_plan"));
        const importArgs = {
          projectId: target.id,
          format,
          document: exported.document,
        };
        for (const projectId of [denied.id, archived.id, "missing-project"])
          for (const name of ["import_project", "export_project"])
            await failure(name, {
              projectId,
              format,
              ...(name === "import_project"
                ? { document: exported.document }
                : {}),
            });
        for (const invalidFormat of [
          "auto",
          "openapi",
          "postman",
          "backup",
          "",
        ])
          for (const name of ["import_project", "export_project"])
            await failure(name, {
              projectId: target.id,
              format: invalidFormat,
              ...(name === "import_project"
                ? { document: exported.document }
                : {}),
            });
        for (const key of [
          "sync",
          "clear",
          "path",
          "url",
          "grants",
          "credentials",
          "newProject",
        ])
          await failure("import_project", { ...importArgs, [key]: true });
        await failure("export_project", {
          projectId: target.id,
          format,
          path: "/tmp/not-an-export-destination",
        });
        for (const name of ["import_project", "export_project"])
          for (const args of [{}, { projectId: target.id }, { format }])
            await failure(name, args);
        for (const document of [
          null,
          [],
          JSON.stringify(exported.document),
          { openapi: "3.1.0", paths: {} },
          { requests: [] },
          format === "apipost"
            ? { format: "apipost-offline-directory-v1", files: [] }
            : { apis: [] },
        ])
          await failure("import_project", { ...importArgs, document });
        await failure("import_project", {
          projectId: target.id,
          format: "apipost",
          document: { apis: [], padding: "界".repeat(1400000) },
        });
        let nested = {};
        for (let depth = 0; depth < 70; depth++) nested = { child: nested };
        await failure("import_project", {
          projectId: target.id,
          format: "apipost",
          document: { apis: [], nested },
        });
        const lateInvalid = structuredClone(exported.document);
        if (format === "apipost")
          lateInvalid.apis.push({
            target_id: "invalid-late-resource",
            target_type: "unrecognized-resource",
          });
        else
          lateInvalid.files.push({
            path: "../../not-a-host-file.json",
            text: "{}",
          });
        await failure("import_project", {
          ...importArgs,
          document: lateInvalid,
        });
        if (format === "apipost-directory") {
          const deepDirectory = structuredClone(exported.document);
          const projectFile = deepDirectory.files.find(
            (entry) => entry.path === "project.json",
          );
          projectFile.text = JSON.stringify({
            ...JSON.parse(projectFile.text),
            nested,
          });
          await failure("import_project", {
            ...importArgs,
            document: deepDirectory,
          });
        }
        await client.ping();
        assert.deepEqual(await store.get(target.id), originalTarget);
        assert.deepEqual(await store.get(denied.id), originalDenied);
        assert.deepEqual(await store.get(archived.id), originalArchived);
        assert.equal(wire.length, 0);

        const imported = await success("import_project", importArgs);
        assert.equal(imported.projectId, target.id);
        assert.equal(imported.format, format);
        assert(Buffer.byteLength(JSON.stringify(imported)) < 65536);
        assert(!JSON.stringify(imported).includes("fictional-saved-secret"));
        let saved = await store.get(target.id);
        assert.deepEqual(
          saved.requests.find((item) => item.id === "keep-existing"),
          originalTarget.requests[0],
        );
        const importedRequest = saved.requests.find(
          (item) => item.name === "SDK saved request",
        );
        assert(importedRequest);
        assert.deepEqual(Object.keys(imported.imported).sort(), [
          "caseIds",
          "documentIds",
          "environmentIds",
          "planIds",
          "protocolIds",
          "requestIds",
        ]);
        assert.deepEqual(imported.imported.requestIds, [importedRequest.id]);
        assert.deepEqual(
          imported.imported.planIds,
          saved.plans.map((item) => item.id),
        );
        assert.deepEqual(
          imported.imported.environmentIds,
          saved.environments
            .filter(
              (item) =>
                !originalTarget.environments.some((old) => old.id === item.id),
            )
            .map((item) => item.id),
        );
        for (const key of ["caseIds", "protocolIds", "documentIds"])
          assert.deepEqual(imported.imported[key], []);
        assert.deepEqual(importedRequest.auth, request.auth);
        assert.equal(importedRequest.url, request.url);
        assert.equal(saved.history.length, 0);
        assert.equal(saved.runs.length, 0);
        assert(
          saved.environments.every(
            (env) => env.variables.executed === undefined,
          ),
        );
        assert.equal(wire.length, 0);
        const targetExport = await success("export_project", {
          projectId: target.id,
          format,
        });
        assert.deepEqual(await store.get(target.id), saved);
        await success("import_project", {
          projectId: second.id,
          format,
          document: targetExport.document,
        });
        const secondState = await store.get(second.id);
        assert.equal(secondState.requests.length, 2);
        assert.equal(secondState.runs.length, 0);
        assert.equal(wire.length, 0);
        assert.deepEqual(
          (await success("list_projects")).map((item) => item.id).sort(),
          [source.id, target.id, second.id].sort(),
        );

        let plan = saved.plans[0];
        if (format === "apipost") {
          const environment = saved.environments.find(
            (env) => env.variables.value === "saved-value",
          );
          assert(environment);
          plan = await success("save_plan", {
            projectId: target.id,
            plan: {
              name: "SDK frozen after JSON import",
              environmentId: environment.id,
              statusPolicy: "strict200",
              steps: [{ request: importedRequest }],
            },
          });
        }
        assert(plan);
        await failure("run_plan", { projectId: target.id, planId: plan.id });
        saved = await store.get(target.id);
        saved.requests.find((item) => item.id === importedRequest.id).url =
          upstreamURL + "/edited-live";
        await store.save(saved);
        const beforeRestart = await store.get(target.id);
        await client.close();
        client = undefined;
        if (app) {
          await closeServer(app.server);
          app = await createApp({ root, port: 0 });
        }
        await connect({ write: true, execute: true });
        assert.deepEqual(await store.get(target.id), beforeRestart);
        assert.equal(wire.length, 0);
        const result = await success("run_plan", {
          projectId: target.id,
          planId: plan.id,
        });
        assert.equal(result.status, "passed", JSON.stringify(result));
        assert.equal(result.results[0].response.status, 200);
        assert.deepEqual(wire, [
          {
            url: "/frozen",
            method: "POST",
            body: '{"value":"saved-value"}',
            authorization:
              "Basic " +
              Buffer.from("fixture:fictional-saved-secret").toString("base64"),
            proof: "frozen",
          },
        ]);
        const executed = await store.get(target.id);
        assert.equal(executed.runs.length, 1);
        assert.equal(
          executed.environments.find((env) => env.id === plan.environmentId)
            .variables.executed,
          "yes",
        );
        assert.deepEqual(await store.get(denied.id), originalDenied);
        assert.deepEqual(await store.get(archived.id), originalArchived);
        assert.deepEqual(await store.get(source.id), originalSource);
        assert.deepEqual(await store.get(second.id), secondState);
      },
    );

test(
  "official SDK stdio rejects the full escaped output frame and oversized error text without losing the session",
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "mcp-frame-sdk-"));
    const store = new Store(root);
    const project = await store.create("P");
    project.environments = [{ id: "e", name: "E", variables: {} }];
    await store.save(project);
    const documentLimit = 4 * 1024 * 1024;
    const frameLimit = 8 * 1024 * 1024;
    const baseline = Buffer.byteLength(JSON.stringify(exportApipost(project)));
    // JSON escaping doubles each backslash at both the document/text and RPC
    // envelope layers. The document itself fits, but the entire frame may not.
    project.description = "\\".repeat(
      Math.floor((documentLimit - baseline) / 2),
    );
    await store.save(project);
    const before = await store.get(project.id);
    const document = exportApipost(before);
    assert.equal(Buffer.byteLength(JSON.stringify(document)), documentLimit);
    const output = { projectId: project.id, format: "apipost", document };
    const result = {
      content: [{ type: "text", text: JSON.stringify(output) }],
    };
    const controlId = "\0".repeat(256);
    const frameBytes = (id) =>
      Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id, result })) + 1;
    assert(frameBytes(10) < frameLimit);
    assert(frameBytes(controlId) > frameLimit);

    const client = new Client(
      { name: "project-frame-sdk", version: "1.0.0" },
      { capabilities: {} },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
        "--project",
        project.id,
        "--write",
      ],
      env: { LOCAL_API_DATA: root },
      stderr: "pipe",
    });
    t.after(async () => {
      await client.close().catch(() => {});
      await rm(root, { recursive: true, force: true });
    });
    await client.connect(transport);
    const args = { projectId: project.id, format: "apipost" };
    const normal = decode(
      await client.callTool({
        name: "localapi_export_project",
        arguments: args,
      }),
    );
    assert.deepEqual(normal, output);

    // Use only the transport's public API to choose a boundary request ID.
    // All unrelated messages still go to the official SDK's existing handler.
    const rawCall = async (id, arguments_) => {
      const previous = transport.onmessage;
      let timer;
      try {
        const response = new Promise((resolve, reject) => {
          timer = setTimeout(
            () => reject(Error("Raw SDK response timeout")),
            10000,
          );
          transport.onmessage = (message) => {
            if (
              message.id === id ||
              (!Object.hasOwn(message, "id") && message.error?.code === -32600)
            )
              resolve(message);
            else previous?.(message);
          };
        });
        await transport.send({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "localapi_export_project", arguments: arguments_ },
        });
        return await response;
      } finally {
        clearTimeout(timer);
        transport.onmessage = previous;
      }
    };
    const rejected = await rawCall(controlId, args);
    assert.equal(rejected.result.isError, true);
    assert.match(rejected.result.content[0].text, /8MiB/);
    assert(Buffer.byteLength(JSON.stringify(rejected)) < 16384);
    await client.ping();
    const invalidId = await rawCall("x".repeat(257), args);
    assert.equal(Object.hasOwn(invalidId, "id"), false);
    assert.equal(invalidId.error.code, -32600);
    assert(Buffer.byteLength(JSON.stringify(invalidId)) < 16384);
    await client.ping();
    const unknown = await client.callTool({
      name: "localapi_export_project",
      arguments: { ...args, ["x".repeat(20000)]: true },
    });
    assert.equal(unknown.isError, true);
    assert(Buffer.byteLength(unknown.content[0].text) < 16384);
    await client.ping();
    const again = decode(
      await client.callTool({
        name: "localapi_export_project",
        arguments: args,
      }),
    );
    assert.deepEqual(again, normal);
    assert.deepEqual(await store.get(project.id), before);
  },
);
