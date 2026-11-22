export const unappliedDesignResponseSettings =
  "响应设置有未应用的修改，请先应用或取消。";

export const unappliedDesignResponseHeader =
  "新增响应头有未应用的修改，请先添加或取消。";

export function unchangedResponseDefinitions(value, definitions) {
  try {
    return JSON.stringify(JSON.parse(value)) === JSON.stringify(definitions);
  } catch {
    return false;
  }
}

export function createDesignResponseSettingsDrafts() {
  const values = new WeakMap();
  return {
    get: (request) => request && values.get(request),
    hasProject(project) {
      return Boolean(project?.requests?.some((request) => values.has(request)));
    },
    notice(project) {
      for (const request of project?.requests || []) {
        const draft = values.get(request);
        if (draft)
          return draft.kind === "header"
            ? unappliedDesignResponseHeader
            : unappliedDesignResponseSettings;
      }
      return "";
    },
    stage(request, draft) {
      values.set(request, draft);
    },
    clear(request) {
      return values.delete(request);
    },
  };
}
