import path from "node:path";
import { performance } from "node:perf_hooks";

export const MAX_LINES = 12000;
export const MAX_BYTES = 4 * 1024 * 1024;
const types = new Set(["test:dequeue", "test:complete", "test:summary"]);

function own(value, key) {
  try {
    return Object.getOwnPropertyDescriptor(value, key)?.value;
  } catch {
    return undefined;
  }
}
function number(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}
function text(value) {
  return typeof value === "string"
    ? value.slice(0, 256).replace(/[\x00-\x1f\x7f]/g, " ")
    : undefined;
}
function relativeFile(value, cwd) {
  if (typeof value !== "string" || value.length > 4096) return undefined;
  const relative = path.relative(cwd, path.resolve(cwd, value));
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    return undefined;
  return text(relative.split(path.sep).join("/"));
}

// Copy only scalar observations, never errors, output, bodies, environment or
// custom serialization hooks. Missing Node fields stay absent, not invented.
export function projectEvent(event, elapsedMs, cwd) {
  const type = own(event, "type");
  if (!types.has(type)) return undefined;
  const data = own(event, "data");
  const file = relativeFile(own(data, "file"), cwd);
  const rawName = own(data, "name");
  const name =
    typeof rawName === "string" && path.isAbsolute(rawName)
      ? relativeFile(rawName, cwd)
      : text(rawName);
  const details = own(data, "details");
  const passed =
    type === "test:summary" ? own(data, "success") : own(details, "passed");
  return {
    type,
    elapsedMs: number(elapsedMs),
    file,
    name,
    line: number(own(data, "line")),
    nesting: number(own(data, "nesting")),
    status:
      type === "test:dequeue"
        ? "dequeued"
        : passed === true
          ? "passed"
          : passed === false
            ? "failed"
            : "unknown",
    durationMs: number(
      type === "test:summary"
        ? own(data, "duration_ms")
        : own(details, "duration_ms"),
    ),
  };
}

export default async function* progress(source) {
  const cwd = process.cwd(),
    started = performance.now();
  let lines = 0,
    bytes = 0,
    capped = false;
  for await (const event of source) {
    // Keep draining after the cap; never end or cancel the source test stream.
    if (capped) continue;
    const projected = projectEvent(event, performance.now() - started, cwd);
    if (!projected) continue;
    const line = JSON.stringify(projected) + "\n";
    const size = Buffer.byteLength(line);
    // Reserve space for a single explicit truncation marker within both caps.
    if (lines >= MAX_LINES - 1 || bytes + size > MAX_BYTES - 128) {
      yield '{"type":"progress:truncated","status":"observation-cap"}\n';
      capped = true;
      continue;
    }
    lines++;
    bytes += size;
    yield line;
  }
}
