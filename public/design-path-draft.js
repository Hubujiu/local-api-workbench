const excluded = ["__proto__", "constructor", "prototype"];

export function designPathNames(url) {
  if (typeof url !== "string" || /[\u0000-\u0020\\]/u.test(url)) return [];
  const match =
    /^(?:https?:\/\/[^/?#]+|\{\{[^{}]+\}\})(\/[^?#]*)?(?:[?#]|$)/iu.exec(url);
  const relative = url.startsWith("/") && !url.startsWith("//");
  const pathname = relative ? url.split(/[?#]/u)[0] : match?.[1] || "";
  if (!pathname) return [];
  const whole = new Map();
  const counts = new Map();
  for (const segment of pathname.split("/")) {
    const parsed = /^\{([A-Za-z0-9_.-]{1,100})\}$/u.exec(segment);
    if (parsed && !excluded.includes(parsed[1]))
      whole.set(parsed[1], (whole.get(parsed[1]) || 0) + 1);
  }
  if (!whole.size) return [];
  // The ordinary serializer replaces a token globally. Do not add a binding
  // that would also alter a query, fragment or partial path.
  for (const [, name] of url.matchAll(/\{([A-Za-z0-9_.-]{1,100})\}/gu))
    if (whole.has(name)) counts.set(name, (counts.get(name) || 0) + 1);
  return [...whole]
    .filter(([name, count]) => counts.get(name) === count)
    .map(([name]) => name);
}

export function usesDesignPathDraft(project, request) {
  return Boolean(
    request &&
      Array.isArray(request.path) &&
      request.graphqlEditorVersion !== 1 &&
      !project?.settings?.nativeInheritance &&
      !request.nativeInheritance &&
      request.scriptURLMode !== "sdk" &&
      request.scriptURLRuntime === undefined &&
      !request.path.some((row) => Object.hasOwn(row, "pathSerialization")),
  );
}

const blank = (key) => ({
  key,
  value: "",
  enabled: true,
  required: true,
  schema: { type: "string" },
});
const untouched = (row, key) =>
  row.key === key &&
  row.value === "" &&
  row.enabled === true &&
  row.required === true &&
  Object.keys(row).length === 5 &&
  row.schema?.type === "string" &&
  Object.keys(row.schema).length === 1;

export function createDesignPathDrafts() {
  const byRequest = new WeakMap();
  function previous(project, request) {
    const record = byRequest.get(request);
    return record?.project === project &&
      record.revision === (project.configRevision ?? project.revision)
      ? record.rows
      : undefined;
  }
  return {
    isLinked(project, request, row) {
      const sourceKey = previous(project, request)?.get(row);
      return sourceKey !== undefined && sourceKey === row.key;
    },
    sync(project, request) {
      if (!usesDesignPathDraft(project, request)) return false;
      const current = new Set(designPathNames(request.url));
      const owned = previous(project, request) || new Map();
      const keep = new Map();
      const path = request.path.filter((row) => {
        const sourceKey = owned.get(row);
        if (!sourceKey) return true;
        if (current.has(sourceKey) && row.key === sourceKey) {
          keep.set(row, sourceKey);
          return true;
        }
        return !untouched(row, sourceKey);
      });
      const known = new Set(path.map((row) => row.key));
      for (const key of current) {
        if (known.has(key)) continue;
        const generated = blank(key);
        path.push(generated);
        keep.set(generated, key);
      }
      byRequest.set(request, {
        project,
        revision: project.configRevision ?? project.revision,
        rows: keep,
      });
      const changed =
        path.length !== request.path.length ||
        path.some((row, index) => row !== request.path[index]);
      if (changed) request.path = path;
      // An edited row can remain in the exact same position while becoming
      // manual. Signal that transition so the mounted row is editable again.
      return changed || keep.size !== owned.size;
    },
  };
}

export function designPathTabLabel(request, { debug = false } = {}) {
  const count = (request.path || []).filter(
    (row) => typeof row.key === "string" && row.key.trim(),
  ).length;
  return count ? `Path${debug ? " " : ""}(${count})` : "Path";
}

export function designPathTable(rows, linked, esc, { debug = false } = {}) {
  return `<table class="pairs-table request-pairs-table design-path-pairs${debug ? " debug-path-pairs" : ""}" aria-label="路径参数"><colgroup><col span="3"></colgroup><thead><tr><th scope="col">参数名</th><th scope="col">参数值</th><th scope="col">描述</th></tr></thead><tbody>${rows
    .map((row, i) => {
      const isLinked = linked(row);
      const id = "path:" + i;
      const name = `<input data-pair="${id}:key" aria-label="路径参数名" placeholder="参数名" value="${esc(row.key)}"${isLinked ? " readonly" : ""}>`;
      const enabled = `<input type="checkbox" data-pair-enabled="${id}" aria-label="启用参数"${row.enabled === false ? "" : " checked"}>`;
      const hasMetadata =
        isLinked && row.schema?.type === "string" && row.required === true;
      const metadata = hasMetadata
        ? '<span class="design-path-type">' +
          (debug ? "string" : "string · 必填") +
          "</span>"
        : "";
      const value =
        row.type === "file"
          ? '<span class="muted">文件数据未作为文本显示。</span>'
          : `<input data-pair="${id}:value" aria-label="路径参数值" placeholder="参数值 / {{变量}}" value="${esc(row.value)}">`;
      const valueCell =
        debug && hasMetadata
          ? `<div class="debug-path-value"><span class="debug-path-required" role="img" aria-label="必填">*</span>${value}</div>`
          : value;
      const actions = isLinked
        ? ""
        : `<div class="pair-row-actions"><button type="button" data-dynamic-pair="${id}">${row.dynamic ? "动态✓" : "动态"}</button><button type="button" data-dictionary-pair="${id}">字典</button><button type="button" data-define-pair="${id}" title="参数类型、必填与说明">定义</button><button type="button" data-remove-pair="${id}" aria-label="删除参数">×</button></div>`;
      return `<tr${isLinked ? " data-design-path-linked" : ""}><td><div class="design-path-name">${isLinked ? "" : enabled}${name}${metadata}</div></td><td>${valueCell}</td><td class="pair-description">${esc(row.description || "")}${actions}</td></tr>`;
    })
    .join(
      "",
    )}</tbody></table><div class="pair-actions"><button type="button" data-add-pair="path">＋ 添加参数</button></div>`;
}
