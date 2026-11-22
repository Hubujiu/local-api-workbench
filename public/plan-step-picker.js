import { folderTree } from "./folder-tree.js";
import { icon } from "./icons.js";

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

export function planPickerEntries(requests) {
  const byPath = new Map();
  for (const request of requests) {
    if (request.deletedAt) continue;
    const path = request.folder || "";
    if (!byPath.has(path)) byPath.set(path, []);
    byPath.get(path).push(request);
  }
  const entries = (path, folders) => [
    ...folders.map(({ name, path, children }) => ({
      name,
      children: entries(path, children),
    })),
    ...(byPath.get(path) || []).map((request) => ({ request })),
  ];
  return entries("", folderTree([...byPath.keys()]));
}

export function renderStepPicker(requests) {
  let sequence = 0;
  const renderEntries = (entries, depth) =>
    entries
      .map(({ request, name, children }) => {
        const indent = ' data-picker-depth="' + Math.min(depth, 5) + '"';
        if (request)
          return (
            '<label class="plan-picker-option" data-picker-path="' +
            esc(request.folder || "") +
            '"' +
            indent +
            '><input type="checkbox" name="plan-picker-api" value="' +
            esc(request.id) +
            '"><span>' +
            esc(request.method) +
            " " +
            esc(request.name) +
            "</span></label>"
          );
        const id = "plan-picker-folder-" + ++sequence;
        return (
          '<div class="plan-picker-branch"><button type="button" class="plan-picker-folder" aria-expanded="true" aria-controls="' +
          id +
          '"' +
          indent +
          '><span class="plan-picker-caret" aria-hidden="true"></span>' +
          icon("folder") +
          "<span>" +
          esc(name) +
          '</span></button><div class="plan-picker-children" id="' +
          id +
          '">' +
          renderEntries(children, depth + 1) +
          "</div></div>"
        );
      })
      .join("");
  const options = renderEntries(planPickerEntries(requests), 0);
  return (
    '<div class="plan-editor-picker"><details id="plan-step-picker"><summary>选择要执行的接口</summary>' +
    '<input type="search" id="plan-step-search" aria-label="搜索接口" placeholder="选择要执行的接口"><div class="plan-picker-popover" role="group" aria-label="HTTP 接口">' +
    options +
    '<p id="plan-step-picker-empty" class="muted" role="status" ' +
    (options ? "hidden" : "") +
    ">没有匹配接口</p></div></details>" +
    '<button id="add-step" type="button" disabled>添加接口</button></div>'
  );
}

// Keep checkboxes mounted, so neither filtering nor disclosure resets selection.
export function bindPlanPickerTree(picker) {
  const search = picker.querySelector("#plan-step-search");
  const popover = picker.querySelector(".plan-picker-popover");
  const empty = picker.querySelector("#plan-step-picker-empty");
  const closed = new Set();
  const searchClosed = new Set();
  const query = () => search.value.trim().toLocaleLowerCase();
  const update = () => {
    const term = query();
    const collapsed = term ? searchClosed : closed;
    const showMatches = (container) => {
      let count = 0;
      for (const row of container.children) {
        if (row.classList.contains("plan-picker-branch")) {
          const [folder, children] = row.children;
          const matched = showMatches(children);
          count += matched;
          row.hidden = matched === 0;
          children.hidden = collapsed.has(folder);
          folder.setAttribute("aria-expanded", String(!children.hidden));
        } else if (row.classList.contains("plan-picker-option")) {
          row.hidden = !(row.dataset.pickerPath + " " + row.textContent)
            .toLocaleLowerCase()
            .includes(term);
          if (!row.hidden) count++;
        }
      }
      return count;
    };
    empty.hidden = showMatches(popover) > 0;
  };
  for (const folder of popover.querySelectorAll(".plan-picker-folder")) {
    folder.addEventListener("click", () => {
      const collapsed = query() ? searchClosed : closed;
      if (collapsed.has(folder)) collapsed.delete(folder);
      else collapsed.add(folder);
      update();
    });
  }
  search.addEventListener("input", () => {
    searchClosed.clear();
    update();
  });
}
