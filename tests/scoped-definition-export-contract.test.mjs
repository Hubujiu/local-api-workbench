import test from "node:test";
import assert from "node:assert/strict";
import { createMCP } from "../src/mcp.mjs";
import Ajv from "ajv";
import { normalizeRequest } from "../src/core.mjs";
import {
  previewDefinitionExport,
  exportDefinitionSelection,
  scopedExportMCPResult,
  scopedExportArguments,
  scopedExportErrorMessage,
} from "../src/scoped-definition-export.mjs";
import { MCP_PROJECT_FRAME_BYTES } from "../src/mcp-project-interchange.mjs";
const source = () => ({
  id: "p",
  name: "P",
  configRevision: 1,
  revision: 1,
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
  requests: [
    normalizeRequest({
      id: "api",
      name: "API",
      url: "https://example.invalid",
    }),
  ],
  environments: [],
  settings: {},
});
const input = () => ({
  format: "apipost",
  selection: { mode: "explicit", resources: [{ kind: "api", id: "api" }] },
});
const accept = (p, args = input()) => {
  const v = previewDefinitionExport(p, args);
  return {
    ...args,
    configRevision: v.configRevision,
    scopeDigest: v.scope.digest,
    acceptedDependencies: v.scope.dependencies,
  };
};
const rpc = (name, args, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "localapi_" + name, arguments: args },
});

test("wrapper source metadata and nested arguments never invoke getters or Proxy traps", () => {
  for (const key of ["id", "archived", "configRevision"]) {
    let hits = 0;
    const p = source();
    Object.defineProperty(p, key, {
      enumerable: true,
      get() {
        hits++;
        return "secret";
      },
    });
    assert.throws(() => previewDefinitionExport(p, input()));
    assert.throws(() => exportDefinitionSelection(p, accept(source())));
    assert.equal(hits, 0, key);
  }
  let hits = 0;
  const proxy = new Proxy(source(), {
    get() {
      hits++;
      throw Error("secret");
    },
    getPrototypeOf() {
      hits++;
      return Object.prototype;
    },
    getOwnPropertyDescriptor() {
      hits++;
      throw Error("secret");
    },
    ownKeys() {
      hits++;
      return [];
    },
  });
  assert.throws(() => previewDefinitionExport(proxy, input()));
  assert.equal(hits, 0);
  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => scopedExportArguments({ ...input(), selection: cycle }));
});

test("direct MCP rejects hostile args before traversal and masks hostile Store errors", async () => {
  const p = source();
  let gets = 0,
    traps = 0;
  const dispatch = createMCP({
    store: {
      get: async () => {
        gets++;
        return structuredClone(p);
      },
    },
    projects: [p.id],
    write: false,
    execute: false,
  });
  const trapped = () =>
    new Proxy(
      {},
      {
        get() {
          traps++;
          throw Error("secret");
        },
        getPrototypeOf() {
          traps++;
          return Object.prototype;
        },
        getOwnPropertyDescriptor() {
          traps++;
          throw Error("secret");
        },
        ownKeys() {
          traps++;
          return [];
        },
      },
    );
  for (const name of ["preview_project_export", "export_project_selection"]) {
    const base = {
      ...(name.startsWith("preview") ? input() : accept(p)),
      projectId: p.id,
    };
    const getter = { ...base };
    Object.defineProperty(getter, "selection", {
      enumerable: true,
      get() {
        traps++;
        return { mode: "all" };
      },
    });
    for (const args of [
      trapped(),
      { ...base, selection: trapped() },
      getter,
      ...(name.startsWith("export")
        ? [{ ...base, acceptedDependencies: trapped() }]
        : []),
    ]) {
      const response = await dispatch(rpc(name, args));
      assert.equal(response.result.isError, true);
      assert.equal(traps, 0);
      assert.equal(gets, 0);
      assert.equal(JSON.stringify(response).includes("secret"), false);
    }
  }
  for (const hostile of [
    { ...source(), requests: trapped() },
    Object.defineProperty(source(), "archived", {
      enumerable: true,
      get() {
        traps++;
        return false;
      },
    }),
  ]) {
    const badSource = createMCP({
      store: { get: async () => hostile },
      projects: [p.id],
    });
    assert.equal(
      (
        await badSource(
          rpc("preview_project_export", { ...input(), projectId: p.id }),
        )
      ).result.isError,
      true,
    );
    assert.equal(traps, 0);
  }
  const error = trapped();
  const bad = createMCP({
    store: {
      get: async () => {
        throw error;
      },
    },
    projects: [p.id],
  });
  assert.equal(
    (await bad(rpc("preview_project_export", { ...input(), projectId: p.id })))
      .result.isError,
    true,
  );
  assert.equal(traps, 0);
  assert.equal(scopedExportErrorMessage(null).includes("失败"), true);
});

test("preview digest binds actual directory timestamp and conversion options; output is detached", () => {
  const p = source(),
    args = { ...input(), format: "apipost-directory" };
  const preview = previewDefinitionExport(p, args),
    good = accept(p, args);
  const output = exportDefinitionSelection(p, good);
  assert.equal(
    output.documentBytes,
    Buffer.byteLength(JSON.stringify(output.document)),
  );
  assert.equal(Object.hasOwn(preview, "document"), false);
  const before = structuredClone(p);
  output.scope.dependencies.push({ kind: "api", id: "other" });
  assert.deepEqual(p, before);
  p.updatedAt = "2025-01-02T00:00:00.000Z";
  p.revision++;
  assert.throws(() => exportDefinitionSelection(p, good), /重新预览/);
  assert.notEqual(
    previewDefinitionExport(p, args).scope.digest,
    preview.scope.digest,
  );
});

test("complete encoded MCP frame boundary includes outer JSON escaping and request ID", () => {
  const small = { value: "" },
    id = "x".repeat(256);
  const encoded = (result) =>
    Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  const overhead = encoded(scopedExportMCPResult(small, id));
  const exact = { value: "a".repeat(MCP_PROJECT_FRAME_BYTES - overhead) };
  const result = scopedExportMCPResult(exact, id);
  assert.equal(encoded(result), MCP_PROJECT_FRAME_BYTES);
  assert.throws(
    () => scopedExportMCPResult({ value: exact.value + "a" }, id),
    /8 MiB/,
  );
  assert.throws(
    () => scopedExportMCPResult({ value: '"'.repeat(3 * 1024 * 1024) }, id),
    /8 MiB/,
  );
});

test("read-only scoped tools are closed and structured or overlong request IDs are not reflected", async () => {
  const p = source(),
    dispatch = createMCP({
      store: { get: async () => structuredClone(p) },
      projects: [p.id],
    });
  const listed = (await dispatch({ id: 1, method: "tools/list" })).result.tools;
  for (const name of ["preview_project_export", "export_project_selection"]) {
    const tool = listed.find((t) => t.name === "localapi_" + name);
    assert.ok(tool);
    assert.equal(tool.inputSchema.additionalProperties, false);
    const validate = new Ajv({ strict: false }).compile(tool.inputSchema);
    const args = {
      ...(name === "preview_project_export" ? input() : accept(p)),
      projectId: p.id,
    };
    assert.equal(validate(args), true, JSON.stringify(validate.errors));
    for (const selection of [
      { mode: "explicit", resources: [] },
      { mode: "all", resources: [] },
      { mode: "explicit", resources: [{ kind: "unknown", id: "x" }] },
      {
        mode: "explicit",
        resources: [{ kind: "api", id: "api", extra: true }],
      },
    ]) {
      assert.equal(
        validate({ ...args, selection }),
        false,
        JSON.stringify(selection),
      );
    }

    for (const id of [
      { secret: "do-not-reflect" },
      "x".repeat(257),
      null,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const response = await dispatch(
        rpc(name, { ...input(), projectId: p.id }, id),
      );
      assert.equal(response.error.code, -32600);
      assert.equal(Object.hasOwn(response, "id"), false);
    }
  }
});
