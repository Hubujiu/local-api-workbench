import { snapshotInterfaceForPlan } from "./plan-snapshots.js";
const control = (node) => ["repeat", "if"].includes(node?.type);
const forbidden = new Set(["__proto__", "constructor", "prototype"]);
function inspect(steps) {
  const ids = new Set();
  const walk = (nodes, depth) => {
    if (!Array.isArray(nodes) || nodes.length > 200)
      throw Error("每层计划步骤最多200项");
    for (const node of nodes) {
      if (!node || typeof node !== "object" || Array.isArray(node))
        throw Error("计划步骤须为对象");
      if (node.id !== undefined) {
        if (
          typeof node.id !== "string" ||
          !node.id ||
          node.id.length > 200 ||
          !node.id.isWellFormed() ||
          forbidden.has(node.id) ||
          ids.has(node.id)
        )
          throw Error("计划步骤ID无效或重复");
        ids.add(node.id);
      }
      if (control(node)) {
        if (depth >= 4) throw Error("条件/循环组嵌套最多4层");
        if (!Array.isArray(node.steps) || !node.steps.length)
          throw Error("条件/循环组至少保留一个子步骤");
        walk(node.steps, depth + 1);
      }
    }
  };
  walk(steps, 0);
  return ids;
}
function children(plan, path) {
  if (!Array.isArray(path)) throw Error("步骤路径无效");
  let nodes = plan.steps;
  for (const index of path) {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= nodes.length ||
      !control(nodes[index])
    )
      throw Error("步骤路径已变化，请重新打开编辑器");
    nodes = nodes[index].steps;
  }
  return nodes;
}
/** Produce an isolated draft only. Server preview and final save remain authoritative. */
export function changePlanStructure(
  plan,
  change,
  generateId = () => crypto.randomUUID(),
) {
  const candidate = structuredClone(plan),
    ids = inspect(candidate.steps);
  const target = children(candidate, change.parentPath ?? []);
  if (change.action === "add") {
    const kind = change.kind ?? "http";
    if (!["http", "repeat", "if"].includes(kind)) throw Error("未知步骤类型");
    if (
      !change.request ||
      change.request.deletedAt ||
      typeof change.request.url !== "string" ||
      !change.request.url.trim()
    )
      throw Error("请选择已有且URL非空的接口作为快照");
    const allocate = () => {
      const id = generateId();
      if (
        typeof id !== "string" ||
        !id ||
        id.length > 200 ||
        !id.isWellFormed() ||
        forbidden.has(id) ||
        ids.has(id)
      )
        throw Error("新步骤ID无效或重复");
      ids.add(id);
      return id;
    };
    const leaf = {
      id: allocate(),
      request: snapshotInterfaceForPlan(change.request),
    };
    target.push(
      kind === "http"
        ? leaf
        : {
            id: allocate(),
            type: kind,
            name: kind === "repeat" ? "循环组" : "条件组",
            ...(kind === "repeat"
              ? { count: 1 }
              : {
                  condition: {
                    op: "eq",
                    left: { literal: true },
                    right: { literal: true },
                  },
                }),
            steps: [leaf],
          },
    );
  } else {
    const index = change.index;
    if (!Number.isSafeInteger(index) || index < 0 || index >= target.length)
      throw Error("步骤位置已变化，请重新打开编辑器");
    if (change.action === "remove") {
      if ((change.parentPath ?? []).length && target.length === 1)
        throw Error("条件/循环组至少保留一个子步骤；可在父层移除整个组");
      target.splice(index, 1);
    } else if (["up", "down"].includes(change.action)) {
      const next = index + (change.action === "up" ? -1 : 1);
      if (next >= 0 && next < target.length)
        [target[index], target[next]] = [target[next], target[index]];
    } else throw Error("未知结构操作");
  }
  inspect(candidate.steps);
  return candidate;
}

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function planStructureEditor() {
  return '<div data-plan-structure><p class="notice">结构编辑只修改草稿，不执行请求。新组必须选择一个已有接口作为首个快照；快照不复制接口脚本。仅支持同层移动，最后一个子步骤不能单独删除。预检不替代最终保存。</p><p data-structure-error role="alert" hidden></p><fieldset data-structure-fields></fieldset><details><summary>完整草稿 JSON（可复制）</summary><textarea data-structure-json readonly rows="12"></textarea></details></div>';
}
export function bindPlanStructureEditor(
  container,
  plan,
  { requests, preview, assertCurrent },
) {
  let draft = structuredClone(plan),
    pending = false;
  const fields = container.querySelector("[data-structure-fields]"),
    error = container.querySelector("[data-structure-error]"),
    json = container.querySelector("[data-structure-json]");
  const pathKey = (path) => path.join(".");
  const sourceOptions = requests
    .filter((r) => !r.deletedAt)
    .map(
      (r) =>
        `<option value="${esc(r.id)}">${esc(r.method || "HTTP")} ${esc(r.name || r.url)}</option>`,
    )
    .join("");
  function render() {
    const list = (nodes, path = []) =>
      '<div class="structure-level">' +
      nodes
        .map((node, index) => {
          const here = [...path, index];
          return `<fieldset><legend>${esc(here.map((i) => i + 1).join("."))} · ${esc(node.name || node.request?.name || node.type || "HTTP")}</legend><div class="row"><button type="button" data-structure-action="up" data-parent="${pathKey(path)}" data-index="${index}" ${index === 0 ? "disabled" : ""}>上移</button><button type="button" data-structure-action="down" data-parent="${pathKey(path)}" data-index="${index}" ${index === nodes.length - 1 ? "disabled" : ""}>下移</button><button type="button" data-structure-action="remove" data-parent="${pathKey(path)}" data-index="${index}" ${path.length && nodes.length === 1 ? "disabled" : ""}>移除${control(node) ? "整组" : "步骤"}</button></div>${control(node) ? list(node.steps, here) : `<p>${esc(node.request?.url || "保留原协议定义与引用")}</p>`}</fieldset>`;
        })
        .join("") +
      `<div class="row"><label>新步骤<select data-new-kind="${pathKey(path)}"><option value="http">HTTP快照</option><option value="repeat">循环组（1次）</option><option value="if">条件组（true等于true）</option></select></label><label>首个接口快照<select data-new-request="${pathKey(path)}">${sourceOptions}</select></label><button type="button" data-structure-action="add" data-parent="${pathKey(path)}" ${sourceOptions ? "" : "disabled"}>添加到此层</button></div></div>`;
    fields.innerHTML = list(draft.steps);
    json.value = JSON.stringify(draft, null, 2);
  }
  fields.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-structure-action]");
    if (!button || !fields.contains(button) || pending || button.disabled)
      return;
    pending = true;
    fields.disabled = true;
    error.hidden = true;
    try {
      assertCurrent();
      const key = button.dataset.parent,
        parentPath = key === "" ? [] : key.split(".").map(Number);
      const change = {
        action: button.dataset.structureAction,
        parentPath,
        index: Number(button.dataset.index),
      };
      if (change.action === "add") {
        change.kind = fields.querySelector(`[data-new-kind="${key}"]`).value;
        change.request = requests.find(
          (r) =>
            r.id === fields.querySelector(`[data-new-request="${key}"]`).value,
        );
      }
      const candidate = changePlanStructure(draft, change);
      await preview(candidate);
      assertCurrent();
      if (!container.isConnected) throw Error("编辑器已关闭，未应用预检结果");
      draft = candidate;
      render();
    } catch (e) {
      if (container.isConnected) {
        error.textContent = e.message;
        error.hidden = false;
      }
    } finally {
      pending = false;
      fields.disabled = false;
    }
  });
  render();
  return () => {
    assertCurrent();
    if (pending) throw Error("结构预检尚未结束，请稍候");
    return structuredClone(draft);
  };
}
