import { createHash } from "node:crypto";
import { types } from "node:util";

// A source evidence container, never a project, plan or native format translator.
export const nativeAutomationArchiveFormat =
  "workbench-native-automation-source-v1";
export const nativeAutomationSourceLimit = 4 * 1024 * 1024;
export const nativeAutomationArchiveLimit = 6 * 1024 * 1024;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function parseSource(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    !bytes.length ||
    bytes.length > nativeAutomationSourceLimit
  )
    throw Error("原生自动化来源须为至多4MiB的非空UTF-8 JSON文件");
  let source;
  try {
    source = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw Error("原生自动化来源不是有效UTF-8 JSON");
  }
  // Bound inspection without recursion or traversing a script, URL or path.
  const pending = [[source, 0]];
  let nodes = 0;
  while (pending.length) {
    const [value, depth] = pending.pop();
    if (++nodes > 100000 || depth > 64)
      throw Error("原生自动化来源结构超过检查上限");
    if (value && typeof value === "object")
      for (const child of Object.values(value)) {
        if (pending.length + nodes >= 100000)
          throw Error("原生自动化来源结构超过检查上限");
        pending.push([child, depth + 1]);
      }
  }
  const project = source?.status === "success" ? source.data : source;
  if (
    !object(project) ||
    typeof project.project_id !== "string" ||
    !project.project_id.trim() ||
    typeof project.name !== "string" ||
    !object(project.global) ||
    !["apis", "models", "samples", "automated_testings"].every((key) =>
      Array.isArray(project[key]),
    ) ||
    !project.automated_testings.length
  )
    throw Error(
      "来源须为完整现代原生JSON且含非空automated_testings；不是executions/flows目录格式",
    );
  return project;
}
function readArchive(value) {
  if (
    !object(value) ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw Error("原生自动化来源档案格式无效");
  const keys = ["format", "execution", "byteLength", "sha256", "sourceBase64"];
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some(
      (key) =>
        !keys.includes(key) ||
        !descriptors[key].enumerable ||
        !Object.hasOwn(descriptors[key], "value"),
    )
  )
    throw Error("原生自动化来源档案字段无效");
  const data = Object.fromEntries(
    keys.map((key) => [key, descriptors[key].value]),
  );
  if (
    data.format !== nativeAutomationArchiveFormat ||
    data.execution !== "unsupported" ||
    !Number.isSafeInteger(data.byteLength) ||
    data.byteLength < 1 ||
    data.byteLength > nativeAutomationSourceLimit ||
    typeof data.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.sha256) ||
    typeof data.sourceBase64 !== "string" ||
    data.sourceBase64.length > Math.ceil(nativeAutomationSourceLimit / 3) * 4
  )
    throw Error("原生自动化来源档案标记或大小无效");
  const bytes = Buffer.from(data.sourceBase64, "base64");
  if (
    bytes.toString("base64") !== data.sourceBase64 ||
    bytes.length !== data.byteLength ||
    hash(bytes) !== data.sha256
  )
    throw Error("原生自动化来源档案完整性校验失败");
  return { bytes, project: parseSource(bytes) };
}
export function archiveNativeAutomationSource(bytes) {
  parseSource(bytes);
  return {
    format: nativeAutomationArchiveFormat,
    execution: "unsupported",
    byteLength: bytes.length,
    sha256: hash(bytes),
    sourceBase64: bytes.toString("base64"),
  };
}
export function restoreNativeAutomationSource(archive) {
  return readArchive(archive).bytes;
}

// Counts and fixed issue codes only: no names, IDs, URLs, script text, settings
// values or credentials enter the summary. Issues are static facts, not repairs,
// guessed runner order, validation of vendor semantics or permission to execute.
export function inspectNativeAutomationSource(archive) {
  const { bytes, project } = readArchive(archive);
  const issues = new Map();
  const issue = (code) => issues.set(code, (issues.get(code) || 0) + 1);
  const apiIds = new Set(
    project.apis
      .filter(object)
      .map((api) => api.target_id)
      .filter((id) => typeof id === "string"),
  );
  let eventCount = 0,
    rootCount = 0,
    nestedCount = 0,
    otherTypeCount = 0;
  const testingIds = new Set();
  for (const testing of project.automated_testings) {
    if (!object(testing)) {
      issue("testing-not-object");
      continue;
    }
    if (typeof testing.testing_id !== "string" || !testing.testing_id)
      issue("testing-id-missing");
    else if (testingIds.has(testing.testing_id)) issue("testing-id-duplicate");
    else testingIds.add(testing.testing_id);
    if (testing.project_id !== project.project_id)
      issue("testing-project-mismatch");
    if (!object(testing.settings)) issue("settings-not-object");
    if (!Array.isArray(testing.event_list)) {
      issue("event-list-not-array");
      continue;
    }
    const byId = new Map(),
      sorts = new Map();
    for (const event of testing.event_list) {
      eventCount++;
      if (!object(event)) {
        issue("event-not-object");
        continue;
      }
      if (typeof event.event_id !== "string" || !event.event_id)
        issue("event-id-missing");
      else if (byId.has(event.event_id)) issue("event-id-duplicate");
      else byId.set(event.event_id, event);
      if (event.test_id !== testing.testing_id) issue("event-testing-mismatch");
      if (event.project_id !== project.project_id)
        issue("event-project-mismatch");
      if (event.parent_event_id === "0") rootCount++;
      else nestedCount++;
      if (event.type !== "api") otherTypeCount++;
      if (
        event.type === "api" &&
        (!object(event.data) || !apiIds.has(event.data.target_id))
      )
        issue("api-reference-unresolved");
      if (!Number.isFinite(event.sort)) issue("sort-not-number");
      else {
        const previous = sorts.get(event.parent_event_id);
        if (previous !== undefined && event.sort <= previous)
          issue("sibling-array-sort-not-increasing");
        sorts.set(event.parent_event_id, event.sort);
      }
    }
    // Linear parent walk, cycle checks do not pick an ordering or resolve refs.
    const done = new Set();
    for (const [id] of byId) {
      const path = new Set();
      let current = id;
      while (current !== "0" && !done.has(current)) {
        if (path.has(current)) {
          issue("parent-cycle");
          break;
        }
        const event = byId.get(current);
        if (!event) {
          issue("parent-reference-unresolved");
          break;
        }
        path.add(current);
        current = event.parent_event_id;
      }
      for (const visited of path) done.add(visited);
    }
  }
  return {
    format: nativeAutomationArchiveFormat,
    execution: "unsupported",
    sourceVersion: "unverified",
    byteLength: bytes.length,
    sha256: hash(bytes),
    automationCount: project.automated_testings.length,
    eventCount,
    rootCount,
    nestedCount,
    otherTypeCount,
    issues: [...issues]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, count]) => ({ code, count })),
    semantics: "not-validated",
  };
}
