import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createMCP } from "../src/mcp.mjs";
import {
  getImportedExecutionRun,
  listImportedExecutionRuns,
} from "../src/imported-execution-history.mjs";
import {
  importedExecutionChunkArguments,
  importedExecutionChunkError,
  validateImportedExecutionChunk,
} from "../src/imported-execution-chunk.mjs";

// Pure synthetic archived data only: no request, plan, script or DB is executed.
const sourceProjectId = "source-A";
const runId = "same-run";
const sourceText =
  '{\n "run_id":"same-run", "project_id":"source-A", "status":"passed",\n' +
  ' "steps":[], "unicode":"界🙂", "number":1e20, "negativeZero":-0\n}\n';
const sha = (text) => createHash("sha256").update(text).digest("hex");
const project = () => ({
  id: "local-project",
  settings: {
    apipostDirectoryArtifacts: [
      {
        sourceProjectId,
        files: [
          {
            path: "executions/runs/index.json",
            text: JSON.stringify({
              version: 2,
              records: [
                {
                  run_id: runId,
                  project_id: sourceProjectId,
                  status: "passed",
                  steps: [],
                  detail_file: "executions/runs/" + runId + ".json",
                },
              ],
            }),
          },
          { path: "executions/runs/" + runId + ".json", text: sourceText },
        ],
      },
    ],
  },
});
const baseArgs = {
  projectId: "local-project",
  sourceProjectId,
  runId,
};
const call = (dispatch, args) =>
  dispatch({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "localapi_get_imported_execution_run", arguments: args },
  });

test("chunk source bytes retain Unicode, whitespace and numeric lexemes; EOF and legacy response are exact", () => {
  const p = project();
  const before = structuredClone(p);
  const full = getImportedExecutionRun(p, sourceProjectId, runId);
  assert.deepEqual(full, {
    provenance: "imported-apipost-archive",
    executedByWorkbench: false,
    ...baseArgs,
    artifactSha256: sha(sourceText),
    original: JSON.parse(sourceText),
  });
  assert.notEqual(JSON.stringify(full.original), sourceText);
  assert.equal(
    listImportedExecutionRuns(p).items[0].artifactSha256,
    sha(sourceText),
  );
  const bytes = Buffer.from(sourceText);
  // Single-byte chunks intentionally split both the CJK and four-byte emoji.
  const parts = [];
  for (let offsetBytes = 0; offsetBytes < bytes.length; offsetBytes++) {
    const item = getImportedExecutionRun(p, sourceProjectId, runId, {
      offsetBytes,
      maxBytes: 1,
      ...(offsetBytes ? { expectedArtifactSha256: sha(sourceText) } : {}),
    });
    assert.equal(item.original, undefined);
    assert.equal(item.executedByWorkbench, false);
    assert.equal(item.artifactSha256, full.artifactSha256);
    assert.equal(item.chunk.encoding, "base64");
    assert.equal(item.chunk.mediaType, "application/json");
    assert.equal(item.chunk.offsetBytes, offsetBytes);
    assert.equal(item.chunk.totalBytes, bytes.length);
    assert.equal(item.chunk.chunkBytes, 1);
    assert.equal(item.chunk.eof, offsetBytes + 1 === bytes.length);
    assert.equal(
      item.chunk.nextOffsetBytes,
      item.chunk.eof ? null : offsetBytes + 1,
    );
    parts.push(Buffer.from(item.chunk.data, "base64"));
  }
  assert.deepEqual(Buffer.concat(parts), bytes);
  assert.equal(sha(Buffer.concat(parts)), full.artifactSha256);
  const eof = getImportedExecutionRun(p, sourceProjectId, runId, {
    offsetBytes: bytes.length,
    expectedArtifactSha256: sha(sourceText),
  }).chunk;
  assert.deepEqual(eof, {
    encoding: "base64",
    mediaType: "application/json",
    offsetBytes: bytes.length,
    chunkBytes: 0,
    totalBytes: bytes.length,
    nextOffsetBytes: null,
    eof: true,
    data: "",
  });
  assert.throws(() =>
    getImportedExecutionRun(p, sourceProjectId, "index", { offsetBytes: 0 }),
  );
  assert.throws(() =>
    getImportedExecutionRun(p, sourceProjectId, runId, {
      offsetBytes: bytes.length + 1,
      expectedArtifactSha256: sha(sourceText),
    }),
  );
  assert.deepEqual(p, before);
});

test("chunk validation is closed, bounded and never invokes getters or Proxy traps", async () => {
  let inspected = 0;
  const trap = () => {
    inspected++;
    throw Error("must not run");
  };
  const hostile = new Proxy(
    {},
    {
      get: trap,
      ownKeys: trap,
      getPrototypeOf: trap,
      getOwnPropertyDescriptor: trap,
    },
  );
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const getter = Object.defineProperty({}, "offsetBytes", {
    enumerable: true,
    get: trap,
  });
  const hidden = Object.defineProperty({ offsetBytes: 0 }, "maxBytes", {
    value: 1,
  });
  const chunks = [
    null,
    undefined,
    false,
    0,
    "0",
    [],
    new Date(),
    {},
    { offsetBytes: -1 },
    { offsetBytes: 0.5 },
    { offsetBytes: "0" },
    { offsetBytes: NaN },
    { offsetBytes: Infinity },
    { offsetBytes: Number.MAX_SAFE_INTEGER + 1 },
    { offsetBytes: 0, maxBytes: 0 },
    { offsetBytes: 0, maxBytes: 262145 },
    { offsetBytes: 0, maxBytes: 1.5 },
    { offsetBytes: 0, maxBytes: "1" },
    { offsetBytes: 0, maxBytes: undefined },
    { offsetBytes: 1 },
    { offsetBytes: 0, expectedArtifactSha256: "A".repeat(64) },
    { offsetBytes: 0, expectedArtifactSha256: "a".repeat(63) },
    { offsetBytes: 0, expectedArtifactSha256: undefined },
    { offsetBytes: 0, ["secret-".repeat(10000)]: true },
    { offsetBytes: 0, [Symbol("hidden")]: true },
    getter,
    hidden,
    hostile,
    revoked.proxy,
  ];
  let reads = 0;
  const dispatch = createMCP({
    store: {
      get: async () => {
        reads++;
        return project();
      },
    },
    projects: [baseArgs.projectId],
  });
  const assertFixed = async (args) => {
    const result = (await call(dispatch, args)).result;
    assert.deepEqual(result, {
      isError: true,
      content: [{ type: "text", text: importedExecutionChunkError }],
    });
  };
  for (const chunk of chunks) {
    assert.throws(() => validateImportedExecutionChunk(chunk));
    await assertFixed({ ...baseArgs, chunk });
  }
  for (const args of [
    hostile,
    revoked.proxy,
    { ...baseArgs, projectId: "界".repeat(342), chunk: { offsetBytes: 0 } },
    { ...baseArgs, projectId: "", chunk: { offsetBytes: 0 } },
    { ...baseArgs, chunk: { offsetBytes: 0 }, ["secret-".repeat(10000)]: true },
    Object.defineProperty({ ...baseArgs }, "chunk", {
      enumerable: true,
      get: trap,
    }),
    Object.defineProperty({ ...baseArgs, chunk: { offsetBytes: 0 } }, "runId", {
      enumerable: true,
      get: trap,
    }),
  ])
    await assertFixed(args);
  assert.equal(reads, 0);
  assert.equal(inspected, 0);
  assert.deepEqual(validateImportedExecutionChunk({ offsetBytes: 0 }), {
    offsetBytes: 0,
    maxBytes: 65536,
  });
  assert.equal(
    validateImportedExecutionChunk({ offsetBytes: 0, maxBytes: 262144 })
      .maxBytes,
    262144,
  );
  assert.equal(importedExecutionChunkArguments(baseArgs), null);
  assert.deepEqual(
    (await dispatch({ jsonrpc: "2.0", id: 2, method: "ping" })).result,
    {},
  );
});

test("chunk errors do not expose Store errors; omitted chunk retains legacy errors and schema", async () => {
  let messageReads = 0;
  const thrown = Object.defineProperty({}, "message", {
    get() {
      messageReads++;
      throw Error("secret");
    },
  });
  const dispatch = createMCP({
    store: {
      get: async () => {
        throw thrown;
      },
    },
    projects: [baseArgs.projectId],
  });
  assert.equal(
    (await call(dispatch, { ...baseArgs, chunk: { offsetBytes: 0 } })).result
      .content[0].text,
    importedExecutionChunkError,
  );
  assert.equal(messageReads, 0);
  const ordinary = createMCP({
    store: {
      get: async () => {
        throw Error("legacy exact error");
      },
    },
    projects: [baseArgs.projectId],
  });
  assert.equal(
    (await call(ordinary, baseArgs)).result.content[0].text,
    "legacy exact error",
  );
  assert.equal(
    (await call(ordinary, null)).result.content[0].text,
    "参数必须为对象",
  );
  assert.equal(
    (await call(ordinary, { ...baseArgs, other: true })).result.content[0].text,
    "未知参数 other",
  );
  const tools = (await ordinary({ id: 3, method: "tools/list" })).result.tools;
  const schema = tools.find(
    (tool) => tool.name === "localapi_get_imported_execution_run",
  ).inputSchema;
  assert.deepEqual(schema.required, ["projectId", "sourceProjectId", "runId"]);
  assert.deepEqual(schema.properties.chunk.required, ["offsetBytes"]);
  assert.equal(schema.properties.chunk.additionalProperties, false);
  assert.equal(
    tools.filter((tool) => tool.name.includes("imported_execution")).length,
    2,
  );
});

test("every chunk reloads and revalidates exact source identity; a digest grants no access", async () => {
  let p = project();
  let reads = 0;
  const dispatch = createMCP({
    store: {
      get: async (key) => {
        reads++;
        assert.equal(key, p.id);
        return p;
      },
    },
    projects: [p.id],
  });
  const read = (patch = {}) =>
    call(dispatch, {
      ...baseArgs,
      chunk: { offsetBytes: 1, expectedArtifactSha256: sha(sourceText) },
      ...patch,
    });
  assert.notEqual((await read()).result.isError, true);
  assert.equal(reads, 1);
  assert.equal(
    (await read({ projectId: "other-existing-project" })).result.isError,
    true,
  );
  assert.equal(reads, 1);
  for (const mutate of [
    () => {
      p.settings.apipostDirectoryArtifacts[0].files[1].text += " ";
    },
    () => {
      p.settings.apipostDirectoryArtifacts = [];
    },
    () => {
      p.settings.apipostDirectoryArtifacts[0].sourceProjectId =
        "different-source";
    },
    () => {
      p.settings.apipostDirectoryArtifacts.push(
        structuredClone(p.settings.apipostDirectoryArtifacts[0]),
      );
    },
    () => {
      p.archived = true;
    },
  ]) {
    p = project();
    mutate();
    const before = structuredClone(p);
    assert.equal(
      (await read()).result.content[0].text,
      importedExecutionChunkError,
    );
    assert.deepEqual(p, before);
    assert.deepEqual((await dispatch({ id: 8, method: "ping" })).result, {});
  }
  p = project();
  assert.equal(
    (
      await read({
        chunk: { offsetBytes: 0, expectedArtifactSha256: "0".repeat(64) },
      })
    ).result.isError,
    true,
  );
  assert.notEqual((await read()).result.isError, true);
});
