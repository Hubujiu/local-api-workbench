import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMCP } from "../src/mcp.mjs";
import { Store } from "../src/runtime.mjs";
import { normalizeRequest } from "../src/core.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import {
  importMCPProject,
  exportMCPProject,
  MCP_PROJECT_DOCUMENT_BYTES,
  MCP_PROJECT_FRAME_BYTES,
} from "../src/mcp-project-interchange.mjs";

function project() {
  return {
    id: "allowed",
    name: "Existing",
    requests: [],
    plans: [],
    cases: [],
    protocols: [],
    documents: [],
    runs: [],
    history: [],
    settings: {},
    environments: [{ id: "env", name: "E", variables: {} }],
  };
}
function document() {
  const p = project();
  p.requests = [
    normalizeRequest({
      id: "native",
      name: "Imported",
      url: "https://example.invalid/do-not-execute",
      auth: {
        type: "basic",
        username: "fixture",
        password: "saved-credential",
      },
    }),
  ];
  return exportApipost(p);
}
const args = (doc = document()) => ({
  projectId: "allowed",
  format: "apipost",
  document: doc,
});
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
const call = (name, arguments_, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "localapi_" + name, arguments: arguments_ },
});

test("canonical project tool schema is closed and respects read/write, allowlist and archived boundaries", async () => {
  let saves = 0;
  const p = project();
  const projects = [p.id];
  const store = {
    get: async () => structuredClone(p),
    save: async () => {
      saves++;
    },
    list: async () => [p],
  };
  const read = createMCP({ store, projects });
  const write = createMCP({ store, projects, write: true, execute: false });
  for (const [dispatch, writable] of [
    [read, false],
    [write, true],
  ]) {
    const tools = (await dispatch({ id: 1, method: "tools/list" })).result
      .tools;
    assert.equal(
      tools.some((t) => t.name === "localapi_import_project"),
      writable,
    );
    const tool = tools.find((t) => t.name === "localapi_export_project");
    assert.deepEqual(tool.inputSchema.required, ["projectId", "format"]);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(tool.inputSchema.properties.format.enum, [
      "apipost",
      "apipost-directory",
    ]);
    for (const format of ["apipost", "apipost-directory"])
      assert.equal(
        decode(
          (await dispatch(call("export_project", { projectId: p.id, format })))
            .result,
        ).format,
        format,
      );
  }
  assert.equal(
    (await read(call("import_project", args()))).result.isError,
    true,
  );
  for (const name of ["import_project", "export_project"]) {
    const base =
      name === "import_project"
        ? args()
        : { projectId: p.id, format: "apipost" };
    for (const extra of [
      { projectId: "denied" },
      { format: "auto" },
      { format: "openapi" },
      { format: "backup" },
      { format: 1 },
      { format: null },
      { path: "/tmp/native.json" },
      { url: "https://example.invalid" },
      { sync: true },
      { clear: true },
      { grants: {} },
      { credentials: {} },
      { newProject: true },
    ])
      assert.equal(
        (await write(call(name, { ...base, ...extra }))).result.isError,
        true,
        JSON.stringify(extra),
      );
    const missing = { ...base };
    delete missing.format;
    assert.equal((await write(call(name, missing))).result.isError, true);
    p.archived = true;
    assert.equal((await write(call(name, base))).result.isError, true);
    p.archived = false;
  }
  assert.equal(saves, 0);
  assert.deepEqual(projects, [p.id]);
  for (const id of [
    "界".repeat(86),
    "x".repeat(MCP_PROJECT_FRAME_BYTES),
    {},
    null,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    Infinity,
  ]) {
    const response = await write(call("import_project", args(), id));
    assert.equal(Object.hasOwn(response, "id"), false);
    assert.equal(response.error.code, -32600);
    assert(Buffer.byteLength(JSON.stringify(response)) < 1024);
  }
  assert.equal(saves, 0);
});

test("outer descriptor and error envelopes stay bounded before any store read or write", async () => {
  let reads = 0,
    saves = 0,
    getters = 0;
  const dispatch = createMCP({
    store: {
      get: async () => {
        reads++;
        return project();
      },
      save: async () => {
        saves++;
      },
    },
    projects: ["allowed"],
    write: true,
  });
  for (const name of ["import_project", "export_project"]) {
    const parameters =
      name === "import_project"
        ? args()
        : { projectId: "allowed", format: "apipost" };
    const accessor = { ...parameters };
    Object.defineProperty(accessor, "format", {
      enumerable: true,
      get() {
        getters++;
        return "apipost";
      },
    });
    if (name === "import_project") {
      const modeAccessor = { ...parameters };
      Object.defineProperty(modeAccessor, "inheritanceMode", {
        enumerable: true,
        get() {
          getters++;
          return "preserve";
        },
      });
      assert.equal(
        (await dispatch(call(name, modeAccessor))).result.isError,
        true,
      );
      await assert.rejects(
        importMCPProject(
          {
            save: async () => {
              saves++;
            },
          },
          project(),
          modeAccessor,
          1,
        ),
      );
    }
    const hidden = { ...parameters };
    Object.defineProperty(hidden, "hidden", { value: true });
    const custom = Object.assign(Object.create({}), parameters);
    const giantKey = { ...parameters, ["x".repeat(8 * 1024 * 1024)]: true };
    for (const rejected of [accessor, hidden, custom, giantKey]) {
      const response = await dispatch(call(name, rejected));
      assert.equal(response.result.isError, true);
      assert(Buffer.byteLength(JSON.stringify(response)) < 16 * 1024);
    }
    if (name === "import_project")
      await assert.rejects(
        importMCPProject(
          {
            save: async () => {
              saves++;
            },
          },
          project(),
          accessor,
          1,
        ),
      );
    else assert.throws(() => exportMCPProject(project(), accessor, 1));
  }
  assert.equal(getters, 0);
  assert.equal(reads, 0);
  assert.equal(saves, 0);
});

test("input rejection is detached and format-specific, including deep embedded directory JSON", async () => {
  const p = project(),
    before = structuredClone(p);
  let saves = 0;
  const store = {
    save: async () => {
      saves++;
    },
  };
  const badSecond = document();
  badSecond.apis.push({
    ...badSecond.apis[0],
    target_id: "bad",
    target_type: "unsupported",
  });
  const duplicate = document();
  duplicate.apis.push(structuredClone(duplicate.apis[0]));
  let deep = {};
  for (let i = 0; i < 65; i++) deep = { nested: deep };
  const accessor = document();
  let getters = 0;
  Object.defineProperty(accessor, "getter", {
    enumerable: true,
    get() {
      getters++;
      return "bad";
    },
  });
  const cyclic = document();
  cyclic.self = cyclic;
  const customArray = document();
  const prototype = Object.create(Array.prototype);
  let toJSONCalls = 0;
  prototype.toJSON = () => {
    toJSONCalls++;
    return [];
  };
  Object.setPrototypeOf(customArray.apis, prototype);
  const directory = exportApipostDirectory(project());
  const traversal = structuredClone(directory);
  traversal.files.push({ path: "../outside.json", text: "{}" });
  const nestedText = structuredClone(directory);
  nestedText.files.find((f) => f.path === "project.json").text =
    '{"unused":' + "[".repeat(65) + "0" + "]".repeat(65) + "}";
  for (const item of [
    args(null),
    args([]),
    args("https://example.invalid/native.json"),
    args("/tmp/native.json"),
    args({ openapi: "3.0.0", paths: {} }),
    args({ item: [] }),
    args({ requests: [] }),
    args(badSecond),
    args(duplicate),
    args(deep),
    args(cyclic),
    args(accessor),
    args(customArray),
    args({
      ...document(),
      ignored: "界".repeat(Math.ceil(MCP_PROJECT_DOCUMENT_BYTES / 3)),
    }),
    args({ ...document(), ignored: Array(200001).fill(0) }),
    args(directory),
    { ...args(), format: "apipost-directory" },
    { ...args(traversal), format: "apipost-directory" },
    { ...args(nestedText), format: "apipost-directory" },
  ]) {
    await assert.rejects(importMCPProject(store, p, item, 1));
    assert.deepEqual(p, before);
  }
  assert.equal(getters, 0);
  assert.equal(toJSONCalls, 0);
  assert.equal(saves, 0);
});

test("merge-only import returns bounded resource IDs, preserves credentials in definitions, and never echoes them in summary", async () => {
  const p = project();
  p.requests = [
    normalizeRequest({
      id: "keep",
      name: "Keep",
      url: "https://example.invalid/keep",
    }),
  ];
  const before = structuredClone(p),
    source = document(),
    sourceBefore = structuredClone(source);
  let saved;
  const store = {
    save: async (draft) => {
      saved = structuredClone(draft);
    },
  };
  const response = decode(await importMCPProject(store, p, args(source), 1));
  assert.deepEqual(p, before);
  assert.deepEqual(source, sourceBefore);
  assert.equal(response.imported.requestIds.length, 1);
  assert.equal(saved.requests.length, 2);
  assert.equal(saved.requests[0].id, "keep");
  assert.equal(saved.requests[1].auth.password, "saved-credential");
  assert.equal(JSON.stringify(response).includes("saved-credential"), false);
  const exported = decode(exportMCPProject(saved, { format: "apipost" }, 1));
  assert.equal(
    exported.document.apis[1].request.auth.basic.password,
    "saved-credential",
  );
  await importMCPProject(store, saved, args(source), 2);
  assert.equal(
    saved.requests.length,
    3,
    "repeated imports append; they do not sync or clear",
  );
});

test("full UTF-8 JSON-RPC frame is checked before save and includes both escaping layers", async () => {
  const p = project();
  const baseline = Buffer.byteLength(JSON.stringify(exportApipost(p)));
  p.description = "\\".repeat(
    Math.floor((MCP_PROJECT_DOCUMENT_BYTES - baseline) / 2),
  );
  const native = exportApipost(p);
  const bytes = Buffer.byteLength(JSON.stringify(native));
  assert(bytes <= MCP_PROJECT_DOCUMENT_BYTES);
  const requestId = "\0".repeat(256);
  assert.equal(Buffer.byteLength(requestId), 256);
  const unbounded = {
    jsonrpc: "2.0",
    id: requestId,
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            projectId: p.id,
            format: "apipost",
            document: native,
          }),
        },
      ],
    },
  };
  assert(
    Buffer.byteLength(JSON.stringify(unbounded)) + 1 > MCP_PROJECT_FRAME_BYTES,
  );
  assert.throws(
    () => exportMCPProject(p, { format: "apipost" }, requestId),
    /完整帧/,
  );
  let saves = 0;
  await assert.rejects(
    importMCPProject(
      {
        save: async () => {
          saves++;
        },
      },
      project(),
      args(),
      "x".repeat(MCP_PROJECT_FRAME_BYTES),
    ),
    /完整帧/,
  );
  assert.equal(saves, 0);
  const successful = exportMCPProject(p, { format: "apipost" }, 1);
  assert(
    Buffer.byteLength(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: successful }),
    ) +
      1 <=
      MCP_PROJECT_FRAME_BYTES,
  );
});

test("Store errors retain identity, are never retried, and successful persistence is required", async () => {
  const p = project(),
    before = structuredClone(p);
  for (const code of ["PROJECT_COMMIT_UNCERTAIN", "ECONFLICT"]) {
    let calls = 0;
    const original = Object.assign(new Error("fixture commit failure"), {
      code,
    });
    await assert.rejects(
      importMCPProject(
        {
          save: async () => {
            calls++;
            throw original;
          },
        },
        p,
        args(),
        1,
      ),
      (error) => error === original,
    );
    assert.equal(calls, 1);
    assert.deepEqual(p, before);
  }
});

test("real Store optimistic conflicts and malformed imports leave persisted state unchanged", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-project-atomic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const created = await store.create("Target");
  const stale = await store.get(created.id);
  const fresh = await store.get(created.id);
  fresh.name = "Concurrent saved edit";
  await store.save(fresh);
  const before = await store.get(created.id);
  await assert.rejects(
    importMCPProject(store, stale, { ...args(), projectId: created.id }, 1),
    /其他窗口/,
  );
  assert.deepEqual(await store.get(created.id), before);
  const invalid = document();
  invalid.apis.push({ target_type: "unknown" });
  await assert.rejects(
    importMCPProject(
      store,
      before,
      { ...args(invalid), projectId: created.id },
      1,
    ),
  );
  assert.deepEqual(await store.get(created.id), before);
});

test("directory exports obey the same embedded JSON budget as their imports", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-project-depth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const p = await store.create("Deep saved variables");
  let deep = {};
  for (let i = 0; i < 65; i++) deep = { child: deep };
  p.environments[0].variables.deep = deep;
  await store.save(p);
  const before = await store.get(p.id);
  assert.throws(
    () => exportMCPProject(before, { format: "apipost" }, 1),
    /64层/,
  );
  assert.throws(
    () => exportMCPProject(before, { format: "apipost-directory" }, 1),
    /64层/,
  );
  assert.deepEqual(await store.get(p.id), before);
  const large = await store.get(p.id);
  // Native env rows carry initial and current values, doubling this collection.
  large.environments[0].variables = { many: Array(60000).fill({}) };
  await store.save(large);
  const wide = await store.get(p.id);
  assert.throws(
    () => exportMCPProject(wide, { format: "apipost-directory" }, 1),
    /结构过大/,
  );
  assert.deepEqual(await store.get(p.id), wide);
});
