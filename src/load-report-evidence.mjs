import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { recordSaveSuccess, recordSaveFailure } from "./execution-evidence.mjs";

const numericFields = [
  "count",
  "requested",
  "concurrency",
  "elapsed",
  "passed",
  "timingSamples",
  "p50",
  "p95",
  "mainRequests",
  "scriptRequests",
  "dataRows",
  "elapsedMs",
  "activeVUs",
  "runningIterations",
  "started",
  "completed",
  "failed",
  "stepCompletionsPerSecond",
  "iterationsCompletedPerSecond",
];
const failures = [
  "http-status-policy",
  "assertion",
  "execution",
  "cancelled",
  "redirect",
];
const reasons = [
  "count",
  "count-limit",
  "duration",
  "cancelled",
  "wire-budget",
  "iteration-limit",
  "completed",
  "observer-failed",
];
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));
const number = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const timestamp = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
function validateSummary(summary, kind) {
  if (
    !exact(summary, [
      ...numericFields,
      "reportSemantics",
      "failureCounts",
      "stopReason",
      "cancelled",
      "networkBudget",
    ])
  )
    throw Error("压测报告摘要格式无效");
  const semantics = summary.reportSemantics;
  if (
    !exact(semantics, ["version", "statusPolicy"]) ||
    semantics.version !== 1 ||
    semantics.statusPolicy !==
      (kind === "one-shot" ? "2xx-and-assertions" : "plan")
  )
    throw Error("压测报告策略无效");
  if (
    !exact(summary.failureCounts, failures) ||
    failures.some(
      (key) =>
        !Number.isSafeInteger(summary.failureCounts[key]) ||
        summary.failureCounts[key] < 0,
    )
  )
    throw Error("压测报告分类无效");
  if (
    !reasons.includes(summary.stopReason) ||
    typeof summary.cancelled !== "boolean"
  )
    throw Error("压测报告终止原因无效");
  for (const key of numericFields)
    if (Object.hasOwn(summary, key) && !number(summary[key]))
      throw Error("压测报告计数无效");
  if (
    summary.networkBudget !== undefined &&
    (!exact(summary.networkBudget, [
      "limit",
      "reservations",
      "started",
      "redirectHops",
    ]) ||
      Object.keys(summary.networkBudget).length !== 4 ||
      Object.values(summary.networkBudget).some(
        (value) => !Number.isSafeInteger(value) || value < 0,
      ))
  )
    throw Error("压测网络预算摘要无效");
}
export function validateLoadRuns(records = []) {
  if (
    !Array.isArray(records) ||
    records.length > 60 ||
    Buffer.byteLength(JSON.stringify(records)) > 1048576
  )
    throw Error("压测报告存储超过上限");
  const ids = new Set();
  let pending = 0;
  for (const record of records) {
    if (
      !exact(record, [
        "version",
        "id",
        "kind",
        "state",
        "startedAt",
        "finishedAt",
        "summary",
      ]) ||
      record.version !== 1 ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(record.id) ||
      ids.has(record.id) ||
      !["one-shot", "staged"].includes(record.kind) ||
      !["pending", "completed", "cancelled", "failed"].includes(record.state) ||
      !timestamp(record.startedAt) ||
      Buffer.byteLength(JSON.stringify(record)) > 16384
    )
      throw Error("压测报告记录无效");
    ids.add(record.id);
    if (record.state === "pending") {
      pending++;
      if (record.finishedAt !== undefined || record.summary !== undefined)
        throw Error("未确认压测不能含终态摘要");
    } else if (
      !timestamp(record.finishedAt) ||
      Date.parse(record.finishedAt) < Date.parse(record.startedAt)
    )
      throw Error("压测报告时间无效");
    if (record.state === "completed" && record.summary === undefined)
      throw Error("已完成压测缺少聚合摘要");
    if (record.summary !== undefined) {
      validateSummary(record.summary, record.kind);
      if (
        record.state === "failed" ||
        record.summary.cancelled !== (record.state === "cancelled")
      )
        throw Error("压测摘要与终态不一致");
    }
  }
  if (pending > 10 || records.length - pending > 50)
    throw Error("压测报告存储超过上限");
}
export function transitionLoadRun(records = [], record) {
  validateLoadRuns(records);
  validateLoadRuns([record]);
  const existing = records.find((item) => item.id === record.id);
  if (existing) {
    if (isDeepStrictEqual(existing, record)) return structuredClone(records);
    if (
      existing.state !== "pending" ||
      record.state === "pending" ||
      existing.kind !== record.kind ||
      existing.startedAt !== record.startedAt
    )
      throw Error("压测报告身份或终态冲突");
  } else if (record.state !== "pending") throw Error("压测报告缺少执行前收据");
  const next = [record, ...records.filter((item) => item.id !== record.id)];
  let terminal = 0;
  const bounded = next.filter(
    (item) => item.state === "pending" || ++terminal <= 50,
  );
  validateLoadRuns(bounded);
  return structuredClone(bounded);
}
export async function beginLoadReport(store, projectId, kind) {
  const record = {
    version: 1,
    id: randomUUID(),
    kind,
    state: "pending",
    startedAt: new Date().toISOString(),
  };
  try {
    await store.writeLoadReport(projectId, record);
    return { record, receipt: recordSaveSuccess(record.id) };
  } catch (error) {
    return { receipt: recordSaveFailure(projectId, record.id, error) };
  }
}
export async function finishLoadReport(
  store,
  projectId,
  pending,
  result,
  cancelled = false,
) {
  const record = {
    ...pending,
    state: result
      ? result.cancelled
        ? "cancelled"
        : "completed"
      : cancelled
        ? "cancelled"
        : "failed",
    finishedAt: new Date(
      Math.max(Date.now(), Date.parse(pending.startedAt)),
    ).toISOString(),
  };
  if (result) {
    const summary = {};
    for (const key of [...numericFields, "stopReason", "cancelled"])
      if (Object.hasOwn(result, key)) summary[key] = result[key];
    summary.reportSemantics = {
      version: result.reportSemantics?.version,
      statusPolicy: result.reportSemantics?.statusPolicy,
    };
    summary.failureCounts = Object.fromEntries(
      failures.map((key) => [key, result.failureCounts?.[key]]),
    );
    if (result.networkBudget)
      summary.networkBudget = Object.fromEntries(
        ["limit", "reservations", "started", "redirectHops"].map((key) => [
          key,
          result.networkBudget[key],
        ]),
      );
    record.summary = summary;
  }
  try {
    await store.writeLoadReport(projectId, record);
    return recordSaveSuccess(record.id);
  } catch (error) {
    return recordSaveFailure(projectId, record.id, error);
  }
}
