import { icon } from "./icons.js";

const item = (label, mark, attributes) =>
  `<button type="button" class="api-create-tile" ${attributes}><span aria-hidden="true">${icon(mark)}</span>${label}</button>`;

export function apiCreateMenu() {
  return `<details class="tree-create">
    <summary class="new-item" aria-controls="api-create-menu" aria-expanded="false">＋ 新建</summary>
    <section id="api-create-menu" popover aria-label="新建或导入项目内容">
      <h2>新建</h2>
      <div class="api-create-grid">
        ${item("HTTP 接口", "▤", 'id="new-request"')}
        ${item("Event Stream · SSE", "⇄", 'data-tree-protocol="sse"')}
        ${item("WebSocket", "⇄", 'data-tree-protocol="websocket"')}
        ${item("Socket.IO 调试", "⇄", 'data-page="socketio"')}
        ${item("gRPC unary 调试", "⇄", 'data-page="grpc"')}
        ${item("TCP 客户端", "⇄", 'data-tree-protocol="tcp"')}
        ${item("Markdown 文档", "▧", 'id="new-tree-document" aria-haspopup="dialog"')}
        ${item("新建目录", "folder", 'id="new-folder" aria-haspopup="dialog"')}
      </div>
      <h2>导入</h2>
      <div class="api-create-grid">
        ${item("粘贴 cURL", "▤", 'data-tree-import="curl" aria-haspopup="dialog"')}
        ${item("粘贴接口定义", "▤", 'data-tree-import="paste" aria-haspopup="dialog"')}
        ${item("选择本地文件", "folder", 'data-tree-import="file" aria-haspopup="dialog"')}
      </div>
    </section>
  </details>`;
}

export function bindApiCreateMenu(root) {
  const trigger = root?.querySelector("summary");
  const panel = root?.querySelector("#api-create-menu");
  if (!trigger || !panel) return;
  const shown = () => panel.matches(":popover-open");
  const position = () => {
    const anchor = trigger.getBoundingClientRect();
    const sidebar = root.closest(".sidebar").getBoundingClientRect();
    const width = Math.min(446, window.innerWidth - 24);
    const x =
      sidebar.right - 3 + width <= window.innerWidth - 12
        ? sidebar.right - 3
        : Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12));
    const y = Math.max(
      12,
      Math.min(
        anchor.top + (anchor.height - panel.offsetHeight) / 2,
        window.innerHeight - panel.offsetHeight - 12,
      ),
    );
    panel.style.setProperty("--api-create-x", x + "px");
    panel.style.setProperty("--api-create-y", y + "px");
  };
  const dismiss = (focus) => {
    if (shown()) panel.hidePopover();
    root.open = false;
    if (focus && trigger.isConnected) trigger.focus({ preventScroll: true });
  };
  trigger.addEventListener("click", (event) => {
    event.preventDefault();
    if (shown()) return dismiss(true);
    root.open = true;
    panel.showPopover();
    position();
    if (event.detail === 0)
      panel.querySelector("button")?.focus({ preventScroll: true });
  });
  panel.addEventListener("beforetoggle", (event) => {
    const opening = event.newState === "open";
    trigger.setAttribute("aria-expanded", String(opening));
    if (!opening) root.open = false;
  });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dismiss(true);
    } else if (
      (event.ctrlKey || event.metaKey) &&
      ["s", "Enter"].includes(event.key)
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
  panel.addEventListener(
    "click",
    (event) => {
      if (event.target.closest(".api-create-tile")) dismiss(true);
    },
    true,
  );
}
