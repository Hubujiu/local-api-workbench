import { readGraphQLNamedQueries } from "./graphql-named-queries.js";

export function graphqlNamedRailHTML(request, esc) {
  const data = readGraphQLNamedQueries(request);
  if (!data) return "";
  return `<nav class="graphql-named-rail" aria-label="GraphQL 查询列表">
    <ul>${data.items
      .map(
        ({
          id,
          name,
        }) => `<li${id === data.activeId ? ' class="selected"' : ""}>
      <button type="button" data-graphql-query-row="${esc(id)}"${id === data.activeId ? ' aria-current="true"' : ""} title="${esc(name)}">${esc(name)}</button>
      <button type="button" class="graphql-named-menu-trigger" data-graphql-query-menu="${esc(id)}" aria-label="查询操作：${esc(name)}" aria-haspopup="menu" aria-expanded="false" aria-controls="graphql-named-query-menu">⋯</button>
    </li>`,
      )
      .join("")}</ul>
    <button type="button" id="graphql-named-add">＋ 新建查询</button>
    <div id="graphql-named-query-menu" role="menu" aria-label="查询操作" popover>
      <button type="button" role="menuitem" tabindex="-1" data-graphql-query-action="rename">重命名</button>
      ${data.items.length > 1 ? '<button type="button" role="menuitem" tabindex="-1" data-graphql-query-action="delete">删除</button>' : ""}
    </div>
    <div id="graphql-named-delete-confirm" role="alertdialog" aria-labelledby="graphql-named-delete-title" aria-describedby="graphql-named-delete-target" popover>
      <strong id="graphql-named-delete-title"><span aria-hidden="true">!</span>删除</strong>
      <p>删除此条查询？</p><span id="graphql-named-delete-target" hidden></span>
      <footer><button type="button" id="graphql-named-delete-cancel">取消</button><button type="button" class="primary" id="graphql-named-delete-apply">确定</button></footer>
    </div>
  </nav>`;
}

export function placeGraphQLDelete(
  anchor,
  width,
  height,
  viewportWidth,
  viewportHeight,
) {
  return {
    x: Math.max(8, Math.min(anchor.right - 54, viewportWidth - width - 8)),
    y: Math.max(8, Math.min(anchor.top - 34, viewportHeight - height - 8)),
  };
}

function bindGraphQLDelete(rail, active, prepareDelete) {
  const popup = rail.querySelector("#graphql-named-delete-confirm");
  const cancel = popup.querySelector("#graphql-named-delete-cancel");
  const apply = popup.querySelector("#graphql-named-delete-apply");
  const targetName = popup.querySelector("#graphql-named-delete-target");
  const visible = () => popup.matches(":popover-open");
  let pending;
  const restore = (button) => {
    if (active() && button?.isConnected) button.focus({ preventScroll: true });
  };
  const dismiss = (restoreFocus) => {
    const saved = pending;
    pending = undefined;
    if (visible()) popup.hidePopover();
    if (restoreFocus) restore(saved?.button);
  };
  let resize;
  const position = () => {
    if (!pending || !visible() || !pending.button.isConnected) return;
    const { x, y } = placeGraphQLDelete(
      pending.button.getBoundingClientRect(),
      popup.offsetWidth,
      popup.offsetHeight,
      innerWidth,
      innerHeight,
    );
    popup.style.setProperty("--graphql-delete-x", x + "px");
    popup.style.setProperty("--graphql-delete-y", y + "px");
  };
  cancel.addEventListener("click", () => dismiss(true));
  apply.addEventListener("click", () => {
    if (!active() || !visible() || !pending?.button?.isConnected) return;
    const action = pending.action;
    dismiss(true);
    action.apply();
  });
  popup.addEventListener("beforetoggle", (event) => {
    if (event.newState !== "closed") return;
    const saved = pending;
    pending = undefined;
    resize?.abort();
    if (saved)
      queueMicrotask(() => {
        const focused = document.activeElement;
        if (
          !visible() &&
          (popup.contains(focused) || focused === document.body)
        )
          restore(saved.button);
      });
  });
  popup.addEventListener("keydown", (event) => {
    if (
      (event.ctrlKey || event.metaKey) &&
      ["s", "Enter"].includes(event.key)
    ) {
      event.preventDefault();
      event.stopPropagation();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dismiss(true);
    } else if (event.key === "Tab") {
      event.preventDefault();
      (event.target === cancel ? apply : cancel).focus();
    }
  });
  // Position synchronously after opening and keep it on-screen if the viewport changes.
  return (button) => {
    const action = prepareDelete(button.dataset.graphqlQueryMenu);
    if (!action || !button.isConnected || !active()) return;
    dismiss(false);
    pending = { button, action };
    targetName.textContent = "查询：" + action.name + "。需显式保存项目。";
    popup.showPopover();
    position();
    resize = new AbortController();
    window.addEventListener(
      "resize",
      () => {
        if (rail.isConnected) position();
        else resize.abort();
      },
      { signal: resize.signal },
    );
    cancel.focus({ preventScroll: true });
  };
}

function bindGraphQLRename(active, prepareRename) {
  let closePrevious;
  return (trigger) => {
    const id = trigger.dataset.graphqlQueryMenu;
    const row = trigger.parentElement.querySelector("[data-graphql-query-row]");
    const action = prepareRename(id);
    if (!action || !row || !row.isConnected || !active()) return;
    closePrevious?.();
    const field = document.createElement("input");
    field.type = "text";
    field.className = "graphql-named-inline-rename";
    field.setAttribute("aria-label", "查询名称");
    field.setAttribute(
      "aria-description",
      "按 Enter 确认；按 Esc 或离开输入框取消。",
    );
    field.title = "Enter 确认 · Esc 取消";
    field.autocomplete = "off";
    field.spellcheck = false;
    field.maxLength = 80;
    field.value = action.name;
    const finish = (restoreFocus) => {
      if (closePrevious !== finish) return;
      closePrevious = undefined;
      row.hidden = false;
      field.remove();
      if (restoreFocus && trigger.isConnected && active())
        trigger.focus({ preventScroll: true });
    };
    closePrevious = finish;
    field.addEventListener("blur", () => finish(false));
    field.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(true);
      } else if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
          return;
        if (!active() || !field.isConnected || closePrevious !== finish) return;
        const applied = action.apply(field.value);
        if (applied === false) finish(true);
      } else if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "s"
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    });
    row.before(field);
    row.hidden = true;
    field.focus({ preventScroll: true });
    field.select();
  };
}

export function bindGraphQLNamedRail(
  rail,
  { active, select, add, prepareRename, prepareDelete },
) {
  const menu = rail.querySelector("#graphql-named-query-menu");
  const items = [...menu.querySelectorAll("[role=menuitem]")];
  const confirmDelete = bindGraphQLDelete(rail, active, prepareDelete);
  const renameInline = bindGraphQLRename(active, prepareRename);
  let trigger;
  const open = () => menu.matches(":popover-open");
  const dismiss = (focus) => {
    const previous = trigger;
    trigger?.setAttribute("aria-expanded", "false");
    trigger = undefined;
    if (open()) menu.hidePopover();
    if (focus && previous?.isConnected) previous.focus({ preventScroll: true });
  };
  const show = (button, index) => {
    if (!active() || !button.isConnected) return;
    if (open() && trigger === button) return dismiss(true);
    dismiss(false);
    trigger = button;
    trigger.setAttribute("aria-expanded", "true");
    menu.showPopover();
    const anchor = button.getBoundingClientRect();
    menu.style.setProperty(
      "--graphql-menu-x",
      Math.max(8, Math.min(anchor.right, innerWidth - menu.offsetWidth - 8)) +
        "px",
    );
    menu.style.setProperty(
      "--graphql-menu-y",
      Math.max(8, Math.min(anchor.top, innerHeight - menu.offsetHeight - 8)) +
        "px",
    );
    items[index]?.focus({ preventScroll: true });
  };
  menu.addEventListener("toggle", () => {
    if (!open()) dismiss(false);
  });
  rail
    .querySelector("#graphql-named-add")
    .addEventListener("click", (event) => {
      if (active()) add(event.detail === 0);
    });
  for (const row of rail.querySelectorAll("[data-graphql-query-row]")) {
    row.addEventListener("click", (event) => {
      if (active()) select(row.dataset.graphqlQueryRow, event.detail === 0);
    });
  }
  for (const button of rail.querySelectorAll("[data-graphql-query-menu]")) {
    button.addEventListener("click", () => show(button, 0));
    button.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
      event.preventDefault();
      show(button, event.key === "ArrowDown" ? 0 : items.length - 1);
    });
  }
  menu.addEventListener("keydown", (event) => {
    if (
      (event.ctrlKey || event.metaKey) &&
      ["s", "Enter"].includes(event.key)
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dismiss(true);
    } else if (event.key === "Tab") dismiss(true);
    else {
      const cursor = items.indexOf(event.target);
      const next = {
        Home: 0,
        End: items.length - 1,
        ArrowUp: (cursor + items.length - 1) % items.length,
        ArrowDown: (cursor + 1) % items.length,
      }[event.key];
      if (!Number.isInteger(next)) return;
      event.preventDefault();
      items[next].focus({ preventScroll: true });
    }
  });
  menu.addEventListener("click", (event) => {
    const item = event.target.closest("[data-graphql-query-action]");
    if (!item || !active() || !trigger?.isConnected || !open()) return;
    const button = trigger;
    dismiss(true);
    if (item.dataset.graphqlQueryAction === "delete") confirmDelete(button);
    else renameInline(button);
  });
}

export function defaultNamedQuery(items) {
  const names = new Set(items.map(({ name }) => name));
  let number = items.length + 1;
  while (names.has("自定义查询 " + number)) number++;
  return "自定义查询 " + number;
}

export function createGraphQLResponseFence() {
  const epochs = new Map();
  return {
    capture: (key) => epochs.get(key),
    clear(key) {
      epochs.set(key, {});
    },
    current: (key, epoch) => epochs.get(key) === epoch,
  };
}
