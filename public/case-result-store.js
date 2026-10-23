export function createCaseResultStore() {
  const projects = new Map();
  const bucket = (id) => {
    if (typeof id !== "string" || !id) throw Error("用例结果须关联项目");
    if (!projects.has(id)) projects.set(id, new Map());
    return projects.get(id);
  };
  return {
    set(projectId, caseId, result, { collapsed = false } = {}) {
      if (typeof caseId !== "string" || !caseId)
        throw Error("用例结果标识无效");
      bucket(projectId).set(caseId, { result, collapsed });
    },
    results(projectId) {
      return new Map(
        [...bucket(projectId)].map(([id, value]) => [id, value.result]),
      );
    },
    collapsed(projectId) {
      return new Set(
        [...bucket(projectId)]
          .filter(([, value]) => value.collapsed)
          .map(([id]) => id),
      );
    },
  };
}
