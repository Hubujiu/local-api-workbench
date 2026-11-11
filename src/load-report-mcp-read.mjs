import { types } from "node:util";
import { projectHistoryProjection } from "./request-definition-history.mjs";
import { validateLoadRuns } from "./load-report-evidence.mjs";

export const loadReportReadError = "MCP_LOAD_REPORT_READ_FAILED";
export function loadReportReadArguments(input, detail = false) {
  const args = projectHistoryProjection(input, {
    maxBytes: 8192,
    maxDepth: 2,
    maxNodes: 8,
  });
  const keys = detail ? ["projectId", "recordId"] : ["projectId"];
  if (
    !args ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    Object.keys(args).length !== keys.length ||
    Object.keys(args).some((key) => !keys.includes(key))
  )
    throw Error(loadReportReadError);
  if (
    typeof args.projectId !== "string" ||
    !args.projectId.trim() ||
    Buffer.byteLength(args.projectId) > 4096
  )
    throw Error(loadReportReadError);
  if (
    detail &&
    (typeof args.recordId !== "string" ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(args.recordId))
  )
    throw Error(loadReportReadError);
  return args;
}

// Only the saved receipt field is inspected. No project definition, controller,
// request snapshot, history fallback or execution callback enters this path.
export function readLoadReport(project, recordId) {
  if (!project || typeof project !== "object" || types.isProxy(project))
    throw Error(loadReportReadError);
  const descriptor = Object.getOwnPropertyDescriptor(project, "loadRuns");
  if (descriptor && !Object.hasOwn(descriptor, "value"))
    throw Error(loadReportReadError);
  const records = projectHistoryProjection(
    descriptor?.value === undefined ? [] : descriptor.value,
    { maxBytes: 1048576, maxDepth: 8, maxNodes: 10000 },
  );
  validateLoadRuns(records);
  if (recordId !== undefined) {
    const record = records.find((item) => item.id === recordId);
    if (!record) throw Error(loadReportReadError);
    return record;
  }
  return {
    records: records.map(({ id, kind, state, startedAt, finishedAt }) => ({
      id,
      kind,
      state,
      startedAt,
      ...(finishedAt === undefined ? {} : { finishedAt }),
    })),
  };
}
