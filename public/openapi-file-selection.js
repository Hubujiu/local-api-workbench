const record = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const knownKind = (kind) =>
  kind === "api" || kind === "model" || kind === "folder";
const MAX_OPERATIONS = 100;

// The converter sorts the parsed object keys and emits api:requests/<index>.
// Only admit direct GET path items so this browser label mapping is provable.
function directGetLabels(document) {
  let source;
  try {
    source = JSON.parse(document.replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
  if (
    !record(source) ||
    !(
      source.swagger === "2.0" ||
      (typeof source.openapi === "string" &&
        /^3\.\d+\.\d+$/.test(source.openapi))
    ) ||
    !record(source.paths)
  )
    return null;
  const paths = Object.keys(source.paths).sort();
  if (!paths.length || paths.length > MAX_OPERATIONS) return null;
  const rows = new Map();
  for (const [index, path] of paths.entries()) {
    const item = source.paths[path];
    if (
      !path.startsWith("/") ||
      path.length > 1024 ||
      /[\s?#]/.test(path) ||
      !record(item) ||
      Object.keys(item).length !== 1 ||
      !record(item.get) ||
      Object.hasOwn(item.get, "$ref")
    )
      return null;
    const { summary, operationId } = item.get;
    const label =
      [summary, operationId].find(
        (value) => typeof value === "string" && value.trim(),
      ) || path;
    rows.set("api:requests/" + index, {
      method: "GET",
      label: label.slice(0, 180),
      path,
    });
  }
  // Repeated summaries must still produce distinguishable rows (without showing
  // servers, credentials, params, bodies, IDs or source snippets).
  const counts = new Map();
  for (const { label } of rows.values())
    counts.set(label, (counts.get(label) || 0) + 1);
  for (const row of rows.values())
    if (counts.get(row.label) > 1) row.label += " · " + row.path;
  return rows;
}

function inventoryFor(items) {
  if (!Array.isArray(items) || items.length > 5000) return null;
  const map = new Map();
  for (const row of items) {
    if (
      !row ||
      !knownKind(row.kind) ||
      typeof row.key !== "string" ||
      !row.key ||
      map.has(row.key) ||
      !Array.isArray(row.dependencies) ||
      new Set(row.dependencies).size !== row.dependencies.length
    )
      return null;
    map.set(row.key, row);
  }
  for (const { dependencies } of items)
    if (dependencies.some((key) => !map.has(key))) return null;
  return map;
}

export function openAPISelectionScope(document, preview) {
  const labels = directGetLabels(document);
  const inventory = inventoryFor(preview.items);
  if (
    !labels ||
    !inventory ||
    typeof preview.sourceDigest !== "string" ||
    !preview.sourceDigest ||
    [...inventory.values()].filter(({ kind }) => kind === "api").length !==
      labels.size ||
    [...labels.keys()].some((key) => inventory.get(key)?.kind !== "api")
  )
    return null;
  const selectedClosure = (keys) => {
    if (
      new Set(keys).size !== keys.length ||
      keys.some((key) => !labels.has(key))
    )
      throw Error("所选接口并非当前文件中的接口");
    const queue = [...keys];
    const selected = new Set();
    while (queue.length) {
      const key = queue.pop();
      if (selected.has(key)) continue;
      selected.add(key);
      queue.push(...inventory.get(key).dependencies);
    }
    return selected;
  };
  return {
    labels,
    inventory,
    selectedClosure,
    sourceDigest: preview.sourceDigest,
  };
}

export function scopedOpenAPIInput(input, keys) {
  return Object.freeze({
    ...input,
    selection: Object.freeze({
      mode: "explicit",
      keys: Object.freeze([...keys]),
    }),
  });
}

export function assertOpenAPISubsetPlan(scope, keys, preview) {
  if (!keys.length) throw Error("请选择至少一个接口");
  const selected = scope.selectedClosure(keys);
  const map = inventoryFor(preview.items);
  const fail = () => {
    throw Error("所选接口及其依赖与预览回执不一致，请重新预览");
  };
  if (
    !map ||
    map.size !== scope.inventory.size ||
    preview.sourceDigest !== scope.sourceDigest
  )
    fail();
  for (const [key, expected] of scope.inventory) {
    const row = map.get(key);
    if (
      row?.kind !== expected.kind ||
      row.dependencies.length !== expected.dependencies.length ||
      row.dependencies.some(
        (dependency) => !expected.dependencies.includes(dependency),
      ) ||
      (selected.has(key)
        ? row.action !== "create" && row.action !== "reuse"
        : row.action !== "skip" || row.reason !== "not_selected")
    )
      fail();
  }
  return new Set([...map.keys()].filter((key) => !selected.has(key)));
}

const actionText = { create: "新增", reuse: "复用", skip: "未选" };

export function bindOpenAPISelection(root, initialFresh, hooks) {
  const all = root.querySelector("#openapi-review-all");
  const checks = [...root.querySelectorAll("[data-openapi-review-check]")];
  const count = root.querySelector("#openapi-review-count");
  const refresh = root.querySelector("#openapi-review-refresh");
  const message = root.querySelector("#openapi-review-selection-status");
  const actions = [...root.querySelectorAll("[data-openapi-review-action]")];
  const read = () =>
    checks.filter((check) => check.checked).map((check) => check.value);
  let generation = 0,
    loading = false,
    locked = false,
    fresh = initialFresh;
  const sync = () => {
    const selected = read().length;
    all.checked = selected === checks.length;
    all.indeterminate = selected > 0 && selected < checks.length;
    count.textContent = "接口（" + selected + "/" + checks.length + "）";
    refresh.disabled = locked || loading || fresh || selected === 0;
  };
  const invalidate = () => {
    generation++;
    fresh = false;
    hooks.invalidate();
    for (const element of actions) element.textContent = "待更新";
    message.textContent = read().length
      ? "选择已变化，更新预览后才能确认。"
      : "未选中接口，不会导入任何内容。";
    sync();
  };
  for (const check of checks) check.addEventListener("change", invalidate);
  all.addEventListener("change", () => {
    for (const check of checks) check.checked = all.checked;
    invalidate();
  });
  refresh.addEventListener("click", async () => {
    if (locked || loading || fresh) return;
    const keys = read();
    if (!keys.length) return;
    const requested = generation;
    const matches = () =>
      generation === requested && read().join("\0") === keys.join("\0");
    loading = true;
    message.textContent = "正在更新所选范围的预览…";
    sync();
    try {
      const accepted = await hooks.preview(keys);
      if (locked || !root.isConnected || !matches()) return;
      const byKey = new Map(
        accepted.preview.items.map((row) => [row.key, row.action]),
      );
      for (const element of actions)
        element.textContent =
          actionText[byKey.get(element.dataset.openapiReviewAction)];
      fresh = true;
      hooks.accept(accepted);
      message.textContent = "预览已更新。所选接口及必要依赖可确认导入。";
    } catch (error) {
      if (!locked && root.isConnected && matches())
        message.textContent = error.message;
    } finally {
      loading = false;
      if (!locked && root.isConnected) sync();
    }
  });
  sync();
  return {
    matches: (keys) => read().join("\0") === keys.join("\0"),
    lock() {
      locked = true;
      for (const control of [all, ...checks, refresh]) control.disabled = true;
    },
  };
}
