const object = (x) => x && typeof x === "object" && !Array.isArray(x);
const identifier = (x) =>
  typeof x === "string" &&
  /^[A-Za-z0-9_-]{1,200}$/.test(x) &&
  !["index", "__proto__", "constructor", "prototype"].includes(x);
export const isExecutionArchivePath = (p) =>
  typeof p === "string" && /^executions\/runs\/[A-Za-z0-9_-]+\.json$/.test(p);
export function executionRecords(files, kind, projectId) {
  const dir = "executions/" + kind,
    key = kind === "flows" ? "flow_id" : "run_id";
  const paths = [...files.keys()].filter(
    (p) => p.startsWith(dir + "/") && p !== dir + "/index.json",
  );
  const index = files.get(dir + "/index.json");
  if (index === undefined && !paths.length) return [];
  if (
    !object(index) ||
    index.version !== 2 ||
    !Array.isArray(index.records) ||
    index.records.length > 50 ||
    Object.keys(index).some(
      (k) => !["version", "records", "updated_at"].includes(k),
    )
  )
    throw Error("原版执行索引无效: " + kind);
  const ids = new Set();
  const records = index.records.map((meta) => {
    if (
      !object(meta) ||
      !identifier(meta[key]) ||
      ids.has(meta[key]) ||
      meta.project_id !== projectId
    )
      throw Error("原版执行索引身份不匹配: " + kind);
    ids.add(meta[key]);
    const file = dir + "/" + meta[key] + ".json",
      record = files.get(file);
    if (
      !object(record) ||
      record[key] !== meta[key] ||
      record.project_id !== projectId ||
      !Array.isArray(record.steps) ||
      record.steps.length > 200
    )
      throw Error("原版执行记录缺失或身份不匹配: " + file);
    for (const [field, value] of Object.entries(meta)) {
      if (["detail_file", "step_count", "steps"].includes(field)) continue;
      if (
        !Object.hasOwn(record, field) ||
        JSON.stringify(record[field]) !== JSON.stringify(value)
      )
        throw Error("原版执行索引与明细不一致: " + file);
    }
    if (kind === "flows") {
      if (meta.step_count !== record.steps.length)
        throw Error("原版计划步骤数不一致");
    } else {
      if (
        meta.detail_file !== file ||
        !Array.isArray(meta.steps) ||
        meta.steps.length !== record.steps.length ||
        !["passed", "failed", "cancelled", "running"].includes(record.status)
      )
        throw Error("原版执行结果索引路径或状态无效");
      meta.steps.forEach((step, i) => {
        if (!object(step) || !object(record.steps[i]))
          throw Error("原版执行结果步骤无效");
        for (const field of [
          "step_id",
          "target_id",
          "name",
          "method",
          "url",
          "status",
          "status_code",
        ])
          if (
            Object.hasOwn(step, field) &&
            JSON.stringify(step[field]) !==
              JSON.stringify(record.steps[i][field])
          )
            throw Error("原版执行结果步骤不一致");
      });
    }
    return structuredClone(record);
  });
  if (paths.length !== ids.size)
    throw Error("原版执行目录包含未列入索引的记录: " + kind);
  return records;
}
