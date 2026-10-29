import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  getImportedExecutionRun,
  listImportedExecutionRuns,
} from "../src/imported-execution-history.mjs";

// Pure reader/JSON fixtures only; no MCP, application, VM or database imports.
const sha = (text) => createHash("sha256").update(text).digest("hex");
function project(sourceProjectId = "index", runIds = []) {
  const records = runIds.map((run_id) => ({
    project_id: sourceProjectId,
    run_id,
    status: "passed",
    steps: [],
    detail_file: `executions/runs/${run_id}.json`,
  }));
  return {
    id: "owned-project",
    settings: {
      apipostDirectoryArtifacts: [
        {
          sourceProjectId,
          files: [
            {
              path: "executions/runs/index.json",
              text: JSON.stringify({ version: 2, records }),
            },
            ...records.map(({ detail_file, ...record }) => ({
              path: detail_file,
              text:
                JSON.stringify(
                  { ...record, payload: "界🙂", number: 0, bool: false },
                  null,
                  2,
                ) + "\n",
            })),
          ],
        },
      ],
    },
  };
}

test("empty and populated archives never expose their reserved index as a run detail", () => {
  for (const runIds of [[], ["real-run"]]) {
    const p = project("index", runIds),
      before = structuredClone(p);
    assert.equal(listImportedExecutionRuns(p).total, runIds.length);
    assert.equal(getImportedExecutionRun(p, "index", "index"), null);
    assert.throws(
      () => getImportedExecutionRun(p, "index", "index", { offsetBytes: 0 }),
      /原始执行记录不存在/,
    );
    assert.deepEqual(p, before);
  }
});

test("source index and case-distinct run names retain pagination, full objects and exact chunk digests", () => {
  const p = project("index", ["Index", "index-1"]),
    before = structuredClone(p);
  const first = listImportedExecutionRuns(p, {
    sourceProjectId: "index",
    limit: 1,
  });
  const second = listImportedExecutionRuns(p, {
    sourceProjectId: "index",
    offset: first.nextOffset,
    limit: 1,
  });
  assert.equal(first.total, 2);
  assert.equal(second.nextOffset, null);
  const rows = [...first.items, ...second.items];
  assert.deepEqual(
    new Set(rows.map((row) => row.runId)),
    new Set(["Index", "index-1"]),
  );
  for (const row of rows) {
    const text = p.settings.apipostDirectoryArtifacts[0].files.find(
      (file) => file.path === `executions/runs/${row.runId}.json`,
    ).text;
    const full = getImportedExecutionRun(p, "index", row.runId);
    assert.deepEqual(full.original, JSON.parse(text));
    assert.equal(full.artifactSha256, row.artifactSha256);
    assert.equal(row.artifactSha256, sha(text));
    const chunk = getImportedExecutionRun(p, "index", row.runId, {
      offsetBytes: 0,
    });
    assert.equal(chunk.artifactSha256, row.artifactSha256);
    assert.deepEqual(
      Buffer.from(chunk.chunk.data, "base64"),
      Buffer.from(text),
    );
    assert.equal(chunk.chunk.eof, true);
  }
  assert.deepEqual(p, before);
});

test("missing sources and runs remain missing rather than falling back to an index or another source", () => {
  const p = project("index", ["real-run"]),
    before = structuredClone(p);
  for (const [source, run] of [
    ["missing", "real-run"],
    ["index", "missing"],
    ["missing", "index"],
  ]) {
    assert.equal(getImportedExecutionRun(p, source, run), null);
    if (run === "index")
      assert.throws(
        () => getImportedExecutionRun(p, source, run, { offsetBytes: 0 }),
        /原始执行记录不存在/,
      );
    else
      assert.equal(
        getImportedExecutionRun(p, source, run, { offsetBytes: 0 }),
        null,
      );
  }
  assert.deepEqual(p, before);
});

test("reserved-name handling does not bypass existing malformed-ID or chunk validation", () => {
  const p = project();
  for (const source of ["", "../source", "__proto__"])
    assert.throws(
      () => getImportedExecutionRun(p, source, "index"),
      /标识无效/,
    );
  for (const chunk of [
    null,
    {},
    { offsetBytes: -1 },
    { offsetBytes: 1 },
    { offsetBytes: 0, extra: true },
  ])
    assert.throws(
      () => getImportedExecutionRun(p, "index", "index", chunk),
      /分块读取失败/,
    );
  for (const run of ["", "../index", "constructor"])
    assert.throws(() => getImportedExecutionRun(p, "index", run), /标识无效/);
});
