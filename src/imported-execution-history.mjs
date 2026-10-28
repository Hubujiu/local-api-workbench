import { createHash } from "node:crypto";
import { normalizeDirectoryArtifacts } from "./apipost-directory-artifacts.mjs";
import {
  validateImportedExecutionChunk,
  validateImportedExecutionChunkProjectId,
} from "./imported-execution-chunk.mjs";
const provenance = "imported-apipost-archive";
const id = (value) => {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(value) ||
    ["__proto__", "prototype", "constructor"].includes(value)
  )
    throw Error("来源项目或原始记录标识无效");
  return value;
};
const text = (value) => (typeof value === "string" ? value.slice(0, 200) : "");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sources = (project) =>
  normalizeDirectoryArtifacts(project.settings?.apipostDirectoryArtifacts);
export function listImportedExecutionRuns(
  project,
  { sourceProjectId, offset = 0, limit = 50 } = {},
) {
  if (sourceProjectId !== undefined) id(sourceProjectId);
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 1000 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw Error("原始记录分页须为整数，offset为0至1000，limit为1至100");
  const items = [];
  for (const source of sources(project)) {
    if (
      sourceProjectId !== undefined &&
      source.sourceProjectId !== sourceProjectId
    )
      continue;
    const files = new Map(source.files.map((f) => [f.path, f.text]));
    const index = files.get("executions/runs/index.json");
    if (!index) continue;
    for (const record of JSON.parse(index).records) {
      const detail = files.get("executions/runs/" + record.run_id + ".json");
      items.push({
        provenance,
        executedByWorkbench: false,
        sourceProjectId: source.sourceProjectId,
        runId: record.run_id,
        flowId: text(record.flow_id),
        flowName: text(record.flow_name),
        originalStatus: record.status,
        startedAt: text(record.started_at),
        finishedAt: text(record.finished_at),
        stepCount: record.steps.length,
        artifactSha256: hash(detail),
      });
    }
  }
  const time = (item) =>
    Number.isFinite(Date.parse(item.startedAt))
      ? Date.parse(item.startedAt)
      : -Infinity;
  items.sort((a, b) =>
    time(a) === time(b)
      ? (a.sourceProjectId + "/" + a.runId).localeCompare(
          b.sourceProjectId + "/" + b.runId,
        )
      : time(b) - time(a),
  );
  return {
    provenance,
    executedByWorkbench: false,
    projectId: project.id,
    total: items.length,
    offset,
    limit,
    nextOffset: offset + limit < items.length ? offset + limit : null,
    items: items.slice(offset, offset + limit),
  };
}
export function getImportedExecutionRun(
  project,
  sourceProjectId,
  runId,
  chunk,
) {
  id(sourceProjectId);
  id(runId);
  if (chunk !== undefined) {
    chunk = validateImportedExecutionChunk(chunk);
    validateImportedExecutionChunkProjectId(project.id);
    if (runId === "index") throw Error("原始执行记录不存在");
  }
  const source = sources(project).find(
    (s) => s.sourceProjectId === sourceProjectId,
  );
  const file = source?.files.find(
    (f) => f.path === "executions/runs/" + runId + ".json",
  );
  if (!file) return null;
  const metadata = {
    provenance,
    executedByWorkbench: false,
    projectId: project.id,
    sourceProjectId,
    runId,
    artifactSha256: hash(file.text),
  };
  if (chunk === undefined)
    return { ...metadata, original: JSON.parse(file.text) };
  if (
    chunk.expectedArtifactSha256 !== undefined &&
    chunk.expectedArtifactSha256 !== metadata.artifactSha256
  )
    throw Error("原始执行记录来源已改变");
  // Return exact accepted source bytes, not the expanded parsed JSON. The
  // source validator above retains the existing 4MiB archive limit and identity
  // checks on every call; no snapshot cache or new JSON-node limit is involved.
  const bytes = Buffer.from(file.text, "utf8");
  if (chunk.offsetBytes > bytes.length) throw Error("原始记录分块偏移越界");
  const end = Math.min(bytes.length, chunk.offsetBytes + chunk.maxBytes);
  return {
    ...metadata,
    chunk: {
      version: 1,
      encoding: "base64",
      mediaType: "application/json",
      offsetBytes: chunk.offsetBytes,
      chunkBytes: end - chunk.offsetBytes,
      totalBytes: bytes.length,
      nextOffsetBytes: end,
      eof: end === bytes.length,
      data: bytes.subarray(chunk.offsetBytes, end).toString("base64"),
    },
  };
}
