import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createMCP } from "../src/mcp.mjs";

const FAILURE = "MCP_LOAD_REPORT_READ_FAILED";
const SECRET = "private-token-and-error-must-not-escape";
const pending = () => ({
  version: 1,
  id: randomUUID(),
  kind: "one-shot",
  state: "pending",
  startedAt: "2026-01-01T00:00:00.000Z",
});
const failed = () => ({
  ...pending(),
  state: "failed",
  finishedAt: "2026-01-01T00:00:01.000Z",
});
const completed = () => ({
  ...failed(),
  state: "completed",
  summary: {
    reportSemantics: { version: 1, statusPolicy: "2xx-and-assertions" },
    failureCounts: {
      "http-status-policy": 0,
      assertion: 0,
      execution: 0,
      cancelled: 0,
      redirect: 0,
    },
    stopReason: "count-limit",
    cancelled: false,
    count: 1,
    passed: 1,
    networkBudget: { limit: 100, reservations: 1, started: 1, redirectHops: 0 },
  },
});
const project = (id = "allowed", records = [pending(), completed()]) => ({
  id,
  name: "Fixture",
  requests: [],
  environments: [],
  loadRuns: records,
});
const request = (name, args, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "localapi_" + name, arguments: args },
});
function decode(response) {
  assert.notEqual(
    response?.result?.isError,
    true,
    response?.result?.content?.[0]?.text,
  );
  return JSON.parse(response.result.content[0].text);
}
function rejected(response) {
  assert.equal(response?.result?.isError, true, JSON.stringify(response));
  assert.deepEqual(response.result.content, [{ type: "text", text: FAILURE }]);
  assert.equal(JSON.stringify(response).includes(SECRET), false);
}
function fixture(p = project(), options = {}) {
  const reads = [];
  const store = {
    get: async (id) => {
      reads.push(id);
      if (id !== p.id) throw Error(SECRET);
      return p;
    },
    save: () => {
      throw Error("read must not write");
    },
  };
  return {
    p,
    reads,
    dispatch: createMCP({
      store,
      projects: [p.id],
      write: false,
      execute: false,
      ...options,
    }),
  };
}
const summary = ({ id, kind, state, startedAt, finishedAt }) => ({
  id,
  kind,
  state,
  startedAt,
  ...(finishedAt === undefined ? {} : { finishedAt }),
});

test("read-only MCP advertises closed load receipt schemas and returns list metadata versus exact detail", async () => {
  const f = fixture();
  const tools = (await f.dispatch({ id: 1, method: "tools/list" })).result
    .tools;
  for (const [name, keys] of [
    ["list_load_reports", ["projectId"]],
    ["get_load_report", ["projectId", "recordId"]],
  ]) {
    const tool = tools.find((t) => t.name === "localapi_" + name);
    assert.ok(tool, name);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual([...tool.inputSchema.required].sort(), [...keys].sort());
    assert.deepEqual(
      Object.keys(tool.inputSchema.properties).sort(),
      [...keys].sort(),
    );
  }
  assert.deepEqual(
    decode(
      await f.dispatch(request("list_load_reports", { projectId: f.p.id })),
    ),
    { records: f.p.loadRuns.map(summary) },
  );
  for (const record of f.p.loadRuns)
    assert.deepEqual(
      decode(
        await f.dispatch(
          request("get_load_report", {
            projectId: f.p.id,
            recordId: record.id,
          }),
        ),
      ),
      record,
    );
  assert.deepEqual(f.reads, [f.p.id, f.p.id, f.p.id]);
});

test("load receipt reads deny ungranted projects before Store access and never fall back across projects", async () => {
  const shared = pending(),
    a = project("a", [shared]),
    b = project("b", [{ ...shared, kind: "staged" }]);
  const reads = [];
  const dispatch = createMCP({
    store: {
      get: async (id) => {
        reads.push(id);
        return id === "a" ? a : b;
      },
    },
    projects: ["a"],
    write: false,
    execute: false,
  });
  for (const name of ["list_load_reports", "get_load_report"])
    rejected(
      await dispatch(
        request(name, {
          projectId: "b",
          ...(name === "get_load_report" ? { recordId: shared.id } : {}),
        }),
      ),
    );
  assert.deepEqual(reads, []);
  assert.deepEqual(
    decode(
      await dispatch(
        request("get_load_report", { projectId: "a", recordId: shared.id }),
      ),
    ),
    shared,
  );
  const missing = randomUUID();
  rejected(
    await dispatch(
      request("get_load_report", { projectId: "a", recordId: missing }),
    ),
  );
  assert.deepEqual(reads, ["a", "a"]);
  const both = createMCP({
    store: { get: async (id) => (id === "a" ? a : b) },
    projects: ["a", "b"],
  });
  assert.deepEqual(
    decode(
      await both(
        request("get_load_report", { projectId: "b", recordId: shared.id }),
      ),
    ),
    b.loadRuns[0],
  );
});

test("archived projects and Store failures expose only the fixed failure text", async () => {
  for (const name of ["list_load_reports", "get_load_report"]) {
    const f = fixture({ ...project(), archived: true });
    const args = {
      projectId: f.p.id,
      ...(name === "get_load_report" ? { recordId: f.p.loadRuns[0].id } : {}),
    };
    rejected(await f.dispatch(request(name, args)));
    for (const thrown of [Error(SECRET), { message: SECRET }, SECRET, null]) {
      const dispatch = createMCP({
        projects: [f.p.id],
        store: {
          get: async () => {
            throw thrown;
          },
        },
      });
      rejected(await dispatch(request(name, args)));
    }
  }
});

test("cancellation is checked before Store access and again after asynchronous reads", async () => {
  for (const name of ["list_load_reports", "get_load_report"]) {
    const f = fixture(),
      args = {
        projectId: f.p.id,
        ...(name === "get_load_report" ? { recordId: f.p.loadRuns[0].id } : {}),
      };
    const controller = new AbortController();
    controller.abort(Error(SECRET));
    rejected(
      await f.dispatch(request(name, args), { signal: controller.signal }),
    );
    assert.deepEqual(f.reads, []);
    const after = new AbortController();
    let reads = 0;
    const dispatch = createMCP({
      projects: [f.p.id],
      store: {
        get: async () => {
          reads++;
          after.abort(Error(SECRET));
          return f.p;
        },
      },
    });
    rejected(await dispatch(request(name, args), { signal: after.signal }));
    assert.equal(reads, 1);
  }
});

test("list returns all 50 terminal and 10 pending receipts without synthesizing summaries or paging", async () => {
  const records = [
    ...Array.from({ length: 50 }, failed),
    ...Array.from({ length: 10 }, pending),
  ];
  const f = fixture(project("allowed", records));
  const result = decode(
    await f.dispatch(request("list_load_reports", { projectId: f.p.id })),
  );
  assert.deepEqual(result, { records: records.map(summary) });
  assert.equal(result.records.length, 60);
  for (const index of [0, 49, 50, 59])
    assert.deepEqual(
      decode(
        await f.dispatch(
          request("get_load_report", {
            projectId: f.p.id,
            recordId: records[index].id,
          }),
        ),
      ),
      records[index],
    );
  for (const bad of [
    [...records, pending()],
    Array.from({ length: 11 }, pending),
    Array.from({ length: 51 }, failed),
  ]) {
    const invalid = fixture(project("allowed", bad));
    rejected(
      await invalid.dispatch(
        request("list_load_reports", { projectId: "allowed" }),
      ),
    );
  }
});

test("legacy absence means an empty list, not reconstructed old execution evidence", async () => {
  const p = project();
  delete p.loadRuns;
  p.runs = [{ id: randomUUID(), secret: SECRET }];
  p.history = [{ id: randomUUID() }];
  const f = fixture(p);
  assert.deepEqual(
    decode(await f.dispatch(request("list_load_reports", { projectId: p.id }))),
    { records: [] },
  );
  rejected(
    await f.dispatch(
      request("get_load_report", { projectId: p.id, recordId: p.runs[0].id }),
    ),
  );
});

test("malformed stored receipts and unknown sensitive fields fail closed rather than getting projected away", async () => {
  const good = completed();
  for (const records of [
    null,
    {},
    [{ ...good, request: { authorization: SECRET } }],
    [{ ...good, summary: { ...good.summary, responseBody: SECRET } }],
    [
      {
        ...good,
        summary: {
          ...good.summary,
          failureCounts: { ...good.summary.failureCounts, secret: SECRET },
        },
      },
    ],
    [good, { ...good }],
    [{ ...pending(), summary: good.summary }],
  ]) {
    const f = fixture(project("allowed", records));
    for (const name of ["list_load_reports", "get_load_report"])
      rejected(
        await f.dispatch(
          request(name, {
            projectId: "allowed",
            ...(name === "get_load_report" ? { recordId: good.id } : {}),
          }),
        ),
      );
  }
});

test("invalid and additional arguments fail before Store reads with no sensitive error reflection", async () => {
  const f = fixture();
  for (const [name, args] of [
    ["list_load_reports", {}],
    ["list_load_reports", { projectId: "allowed", limit: 1 }],
    ["list_load_reports", { projectId: "allowed", cursor: SECRET }],
    ["list_load_reports", { projectId: 123 }],
    ["list_load_reports", { projectId: "" }],
    ["get_load_report", { projectId: "allowed" }],
    ["get_load_report", { projectId: "allowed", recordId: SECRET }],
    [
      "get_load_report",
      { projectId: "allowed", recordId: randomUUID(), includeBody: true },
    ],
    ["get_load_report", { projectId: "allowed", recordId: { secret: SECRET } }],
    ["list_load_reports", null],
    ["list_load_reports", []],
  ])
    rejected(await f.dispatch(request(name, args)));
  assert.deepEqual(f.reads, []);
});

test("unsafe JSON-RPC IDs are never reflected and cannot trigger Store reads", async () => {
  const f = fixture(),
    args = { projectId: f.p.id };
  for (const id of [
    { secret: SECRET },
    [SECRET],
    true,
    null,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    SECRET.repeat(10000),
  ]) {
    const response = await f.dispatch(request("list_load_reports", args, id));
    assert.deepEqual(response.error, { code: -32600, message: FAILURE });
    assert.equal(JSON.stringify(response).includes(SECRET), false);
    assert.ok(
      response.id === undefined || response.id === null,
      "invalid RPC id must not be reflected",
    );
  }
  assert.deepEqual(f.reads, []);
  const notification = request("list_load_reports", args);
  delete notification.id;
  assert.equal(await f.dispatch(notification), null);
  assert.deepEqual(f.reads, []);
  for (const id of [0, 7, "rpc-load-read"]) {
    const response = await f.dispatch(request("list_load_reports", args, id));
    assert.equal(response.id, id);
    decode(response);
  }
});

test("RPC and project identifier byte limits enforce UTF-8 boundaries before reads", async () => {
  const p = project("界".repeat(1365) + "a"),
    f = fixture(p);
  for (const id of [
    "a".repeat(256),
    "🙂".repeat(64),
    Number.MAX_SAFE_INTEGER,
  ]) {
    const response = await f.dispatch(
      request("list_load_reports", { projectId: p.id }, id),
    );
    assert.equal(response.id, id);
    decode(response);
  }
  const before = f.reads.length;
  for (const id of ["a".repeat(257), "🙂".repeat(64) + "a"]) {
    const r = await f.dispatch(
      request("list_load_reports", { projectId: p.id }, id),
    );
    assert.deepEqual(r.error, { code: -32600, message: FAILURE });
    assert.ok(r.id === undefined || r.id === null);
  }
  for (const projectId of [p.id + "a", " ", "\n\t"])
    rejected(await f.dispatch(request("list_load_reports", { projectId })));
  assert.equal(f.reads.length, before);
});

test("argument and evidence projection rejects accessors, hidden fields and hooks without invoking them", async () => {
  let touched = 0;
  const badArgs = [
    Object.defineProperty({}, "projectId", {
      enumerable: true,
      get() {
        touched++;
        return "allowed";
      },
    }),
    Object.defineProperty({ projectId: "allowed" }, "secret", {
      value: SECRET,
    }),
    {
      projectId: "allowed",
      toJSON() {
        touched++;
        return { projectId: "allowed" };
      },
    },
    new Proxy(
      { projectId: "allowed" },
      {
        ownKeys() {
          touched++;
          return ["projectId"];
        },
      },
    ),
  ];
  const f = fixture();
  for (const args of badArgs)
    rejected(await f.dispatch(request("list_load_reports", args)));
  assert.equal(touched, 0);
  assert.deepEqual(f.reads, []);
  const source = completed();
  for (const record of [
    Object.defineProperty({ ...source }, "summary", {
      enumerable: true,
      get() {
        touched++;
        return source.summary;
      },
    }),
    Object.defineProperty({ ...source }, "secret", { value: SECRET }),
    {
      ...source,
      toJSON() {
        touched++;
        return source;
      },
    },
    new Proxy(source, {
      ownKeys() {
        touched++;
        return Object.keys(source);
      },
    }),
  ]) {
    const bad = fixture(project("allowed", [record]));
    for (const name of ["list_load_reports", "get_load_report"])
      rejected(
        await bad.dispatch(
          request(name, {
            projectId: "allowed",
            ...(name === "get_load_report" ? { recordId: source.id } : {}),
          }),
        ),
      );
  }
  assert.equal(touched, 0);
});

test("fixed Store error handling does not inspect hostile exception properties", async () => {
  let touched = 0;
  const errors = [
    Object.defineProperty({}, "message", {
      get() {
        touched++;
        return SECRET;
      },
    }),
    new Proxy(
      {},
      {
        get() {
          touched++;
          throw Error(SECRET);
        },
        ownKeys() {
          touched++;
          return [];
        },
      },
    ),
  ];
  for (const thrown of errors) {
    const dispatch = createMCP({
      projects: ["allowed"],
      store: {
        get: async () => {
          throw thrown;
        },
      },
    });
    for (const name of ["list_load_reports", "get_load_report"])
      rejected(
        await dispatch(
          request(name, {
            projectId: "allowed",
            ...(name === "get_load_report" ? { recordId: randomUUID() } : {}),
          }),
        ),
      );
  }
  assert.equal(touched, 0);
});
