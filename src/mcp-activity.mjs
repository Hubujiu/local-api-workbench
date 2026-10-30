import {
  mkdir,
  writeFile,
  readFile,
  readdir,
  stat,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { renameProgress } from "./rename-progress.mjs";
import { randomUUID } from "node:crypto";
const folder = (root) => path.join(root, ".mcp-activities");
const validMetadata = (value, limit = 200) =>
  typeof value === "string" &&
  value.isWellFormed() &&
  Buffer.byteLength(value) <= limit &&
  !/[\x00-\x1f\x7f]/.test(value);
const metadata = (value, limit) => {
  if (!validMetadata(value, limit)) throw Error("MCP活动元数据无效或过长");
  return value;
};
const live = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
};
export async function readMCPActivities(root, now = Date.now()) {
  let names;
  try {
    names = (await readdir(folder(root))).filter((name) =>
      /^[a-f0-9-]{36}\.json$/.test(name),
    );
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const sorted = (
    await Promise.all(
      names.map(async (name) => {
        try {
          return {
            name,
            modified: (await stat(path.join(folder(root), name))).mtimeMs,
          };
        } catch {
          return null;
        }
      }),
    )
  )
    .filter(Boolean)
    .sort((a, b) => b.modified - a.modified)
    .slice(0, 200);
  const rows = [];
  for (const { name } of sorted) {
    try {
      const file = path.join(folder(root), name);
      if ((await stat(file)).size > 4096) continue;
      const record = JSON.parse(await readFile(file, "utf8"));
      if (
        record.id + ".json" !== name ||
        record.source !== "stdio" ||
        !Number.isInteger(record.pid) ||
        record.pid <= 0 ||
        !["running", "completed", "failed", "cancelled"].includes(record.status)
      )
        continue;
      const row = { ...record };
      if (
        row.status === "running" &&
        (!Number.isFinite(Date.parse(row.updatedAt)) ||
          now - Date.parse(row.updatedAt) > 10000 ||
          !live(row.pid))
      )
        row.status = "interrupted";
      rows.push(row);
    } catch {}
  }
  const running = rows.filter((row) => row.status === "running");
  const finished = rows.filter((row) => row.status !== "running").slice(0, 50);
  return [...running, ...finished];
}
export class MCPActivity {
  constructor(root, info) {
    this.root = root;
    this.record = {
      id: randomUUID(),
      source: "stdio",
      pid: process.pid,
      tool: metadata(info.tool, 128),
      projectId: metadata(info.projectId),
      ...(info.planId !== undefined ? { planId: metadata(info.planId) } : {}),
      status: "running",
      startedAt: new Date().toISOString(),
      completed: 0,
    };
    this.pending = Promise.resolve();
  }
  async start() {
    if (this.started) throw Error("MCP activity already started");
    this.started = true;
    await mkdir(folder(this.root), { recursive: true, mode: 0o700 });
    const old = await readMCPActivities(this.root);
    for (const row of old.filter((row) => row.status !== "running").slice(30))
      await rm(path.join(folder(this.root), row.id + ".json"), { force: true });
    await this.flush();
    this.timer = setInterval(() => this.flush().catch(() => {}), 2000);
    this.timer.unref();
    return this;
  }
  flush() {
    this.record.updatedAt = new Date().toISOString();
    const content = JSON.stringify(this.record);
    if (Buffer.byteLength(content) > 4096) throw Error("MCP活动记录超过4KiB");
    this.pending = this.pending
      .catch(() => {})
      .then(async () => {
        const file = path.join(folder(this.root), this.record.id + ".json"),
          temporary = file + "." + randomUUID() + ".tmp";
        try {
          await writeFile(temporary, content, { mode: 0o600 });
          await renameProgress(temporary, file);
        } finally {
          await rm(temporary, { force: true }).catch(() => {});
        }
      });
    return this.pending;
  }
  update(progress) {
    if (this.finished) return this.pending;
    for (const key of ["completed", "total"])
      if (Number.isInteger(progress[key]) && progress[key] >= 0)
        this.record[key] = progress[key];
    if (typeof progress.stepId === "string") {
      if (validMetadata(progress.stepId)) {
        this.record.stepId = progress.stepId;
        delete this.record.stepIdOmitted;
      } else {
        delete this.record.stepId;
        this.record.stepIdOmitted = true;
      }
    }
    const pathDescriptor =
      progress.repeat &&
      Object.getOwnPropertyDescriptor(progress.repeat, "path");
    let repeatPath;
    let validRepeatPath = !pathDescriptor;
    if (pathDescriptor?.enumerable && Object.hasOwn(pathDescriptor, "value")) {
      const rawPath = pathDescriptor.value;
      if (
        Array.isArray(rawPath) &&
        Object.getPrototypeOf(rawPath) === Array.prototype &&
        rawPath.length >= 2 &&
        rawPath.length <= 4 &&
        Reflect.ownKeys(rawPath).length === rawPath.length + 1
      ) {
        repeatPath = [];
        for (let i = 0; i < rawPath.length; i++) {
          const item = Object.getOwnPropertyDescriptor(rawPath, String(i));
          if (!item?.enumerable || !Object.hasOwn(item, "value")) break;
          const entry = item.value;
          if (
            !entry ||
            typeof entry !== "object" ||
            ![Object.prototype, null].includes(Object.getPrototypeOf(entry)) ||
            Reflect.ownKeys(entry).length !== 2
          )
            break;
          const group = Object.getOwnPropertyDescriptor(entry, "groupId");
          const index = Object.getOwnPropertyDescriptor(entry, "iteration");
          if (
            !group?.enumerable ||
            !index?.enumerable ||
            !Object.hasOwn(group, "value") ||
            !Object.hasOwn(index, "value") ||
            !validMetadata(group.value) ||
            !Number.isInteger(index.value) ||
            index.value < 0 ||
            index.value >= 100
          )
            break;
          repeatPath.push({ groupId: group.value, iteration: index.value });
        }
        validRepeatPath =
          repeatPath.length === rawPath.length &&
          repeatPath.at(-1).groupId === progress.repeat.groupId &&
          repeatPath.at(-1).iteration === progress.repeat.iteration &&
          progress.repeat.occurrenceId ===
            JSON.stringify([
              repeatPath.map(({ groupId, iteration }) => [groupId, iteration]),
              progress.repeat.childId,
            ]);
      }
    }
    if (
      progress.repeat &&
      validRepeatPath &&
      ["groupId", "childId"].every((key) =>
        validMetadata(progress.repeat[key]),
      ) &&
      Number.isInteger(progress.repeat.iteration) &&
      progress.repeat.iteration >= 0 &&
      progress.repeat.iteration < 100 &&
      typeof progress.repeat.occurrenceId === "string" &&
      validMetadata(progress.repeat.occurrenceId, 1500) &&
      Buffer.byteLength(JSON.stringify(progress.repeat)) <= 2048
    )
      this.record.repeat = {
        groupId: progress.repeat.groupId,
        childId: progress.repeat.childId,
        iteration: progress.repeat.iteration,
        occurrenceId: progress.repeat.occurrenceId,
        ...(repeatPath === undefined
          ? {}
          : {
              path: repeatPath.map(({ groupId, iteration }) => ({
                groupId,
                iteration,
              })),
            }),
      };
    else delete this.record.repeat;
    if (progress.repeat && !this.record.repeat)
      this.record.repeatOmitted = true;
    else delete this.record.repeatOmitted;
    const status = progress.stepStatus || progress.status;
    if (["passed", "failed", "cancelled"].includes(status))
      this.record.stepStatus = status;
    if (status === "failed") this.failed = true;
    return this.flush();
  }
  async finish(error = false, { status, recordSaved } = {}) {
    if (this.finished) return this.pending;
    this.finished = true;
    clearInterval(this.timer);
    this.record.status =
      error || recordSaved === false
        ? "failed"
        : status === "cancelled"
          ? "cancelled"
          : status === "failed" || this.failed
            ? "failed"
            : "completed";
    if (["passed", "failed", "cancelled"].includes(status))
      this.record.executionStatus = status;
    if (typeof recordSaved === "boolean") this.record.recordSaved = recordSaved;
    if (recordSaved === false) {
      this.record.persistenceError = "执行记录保存失败；不会重新执行请求";
    }
    this.record.finishedAt = new Date().toISOString();
    await this.flush();
  }
}
