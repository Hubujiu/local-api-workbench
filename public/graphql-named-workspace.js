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
  </nav>`;
}

export function bindGraphQLNamedRail(rail, { active, select, add, arrange }) {
  const menu = rail.querySelector("#graphql-named-query-menu");
  const items = [...menu.querySelectorAll("[role=menuitem]")];
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
    const id = trigger.dataset.graphqlQueryMenu;
    dismiss(true);
    arrange(item.dataset.graphqlQueryAction, id);
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
