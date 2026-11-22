export const unappliedDesignResponseSettings =
  "响应设置有未应用的修改，请先应用或取消。";

export function createDesignResponseSettingsDrafts() {
  const values = new WeakMap();
  return {
    get: (request) => request && values.get(request),
    hasProject(project) {
      return Boolean(project?.requests?.some((request) => values.has(request)));
    },
    stage(request, draft) {
      values.set(request, draft);
    },
    clear(request) {
      return values.delete(request);
    },
  };
}
