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
          '<div class="plan-picker-branch"><div class="plan-picker-folder-heading"' +
          indent +
          '><button type="button" class="plan-picker-folder" aria-expanded="true" aria-controls="' +
          id +
          '"><span class="plan-picker-caret" aria-hidden="true"></span>' +
          icon("folder") +
          "<span>" +
          esc(name) +
          '</span></button><input class="plan-picker-folder-check" type="checkbox" aria-label="选择 ' +
          esc(name) +
          ' 中的全部接口"></div><div class="plan-picker-children" id="' +
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
    '<div class="plan-picker-field"><div class="plan-picker-chips" role="group" aria-label="已选接口" hidden></div><input type="search" id="plan-step-search" aria-label="搜索接口" placeholder="选择要执行的接口"></div><div class="plan-picker-popover" role="group" aria-label="HTTP 接口">' +
    options +
    '<p id="plan-step-picker-empty" class="muted" role="status" ' +
    (options ? "hidden" : "") +
    ">没有匹配接口</p></div></details>" +
    '<button id="add-step" type="button" disabled>添加接口</button></div>'
  );
}

// Keep checkboxes mounted, so neither filtering nor disclosure resets selection.
export function createPlanPickerSelection() {
  const selected = new Set();
  return {
    ids: () => [...selected],
    count: () => selected.size,
    has: (id) => selected.has(id),
    set(id, checked) {
      if (checked) selected.add(id);
      else selected.delete(id);
    },
    state(ids) {
      const count = ids.filter((id) => selected.has(id)).length;
      return {
        checked: count === ids.length && count > 0,
        mixed: count > 0 && count < ids.length,
      };
    },
    toggleFolder(ids) {
      const checked = !ids.every((id) => selected.has(id));
      for (const id of ids) {
        if (checked) selected.add(id);
        else selected.delete(id);
      }
    },
  };
}

export function bindPlanPickerTree(picker, onCount) {
  const search = picker.querySelector("#plan-step-search");
  const popover = picker.querySelector(".plan-picker-popover");
  const empty = picker.querySelector("#plan-step-picker-empty");
  const chips = picker.querySelector(".plan-picker-chips");
  const doc = picker.ownerDocument;
  const selection = createPlanPickerSelection();
  const readOptions = (container) => [
    ...container.querySelectorAll('input[name="plan-picker-api"]'),
  ];
  const options = readOptions(popover);
  const labelsById = new Map(
    options.map((option) => [
      option.value,
      option.closest("label").textContent,
    ]),
  );
  const branches = [...popover.querySelectorAll(".plan-picker-branch")].map(
    (branch) => ({
      box: branch.firstElementChild.querySelector(".plan-picker-folder-check"),
      ids: readOptions(branch.lastElementChild).map((option) => option.value),
    }),
  );
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
          const [heading, children] = row.children;
          const folder = heading.firstElementChild;
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
  const updateSelection = () => {
    for (const option of options) option.checked = selection.has(option.value);
    for (const { box, ids } of branches) {
      const { checked, mixed } = selection.state(ids);
      box.checked = checked;
      box.indeterminate = mixed;
    }
    chips.replaceChildren(
      ...selection.ids().map((id) => {
        const button = doc.createElement("button");
        button.type = "button";
        button.className = "plan-picker-chip";
        const label = labelsById.get(id);
        button.setAttribute("aria-label", "移除 " + label);
        button.title = "移除 " + label;
        const text = doc.createElement("span");
        text.textContent = label;
        const remove = doc.createElement("span");
        remove.textContent = "×";
        remove.setAttribute("aria-hidden", "true");
        button.append(text, remove);
        button.addEventListener("click", () => {
          selection.set(id, false);
          // Move focus before replacing the focused chip, and keep the popup open.
          search.focus();
          updateSelection();
        });
        return button;
      }),
    );
    chips.hidden = !selection.count();
    search.placeholder = selection.count() ? "" : "选择要执行的接口";
    onCount(selection.count());
  };
  for (const option of options) {
    option.addEventListener("change", () => {
      selection.set(option.value, option.checked);
      updateSelection();
    });
  }
  for (const { box, ids } of branches) {
    box.addEventListener("change", () => {
      const wasFiltering = !!query();
      selection.toggleFolder(ids);
      if (wasFiltering) {
        search.value = "";
        searchClosed.clear();
        update();
        search.focus();
      }
      updateSelection();
    });
  }
  search.addEventListener("input", () => {
    searchClosed.clear();
    update();
  });
  return selection.ids;
}
