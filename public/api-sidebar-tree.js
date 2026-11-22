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

export function workspaceTreeItems(project, search, searchType) {
  return [
    ...(project?.requests || [])
      .filter((item) => !item.deletedAt)
      .map((item) => ({
        ...item,
        kind: "http",
        label: item.method === "DELETE" ? "DEL" : item.method,
        attribute: ["data-request", item.id],
      })),
    ...(project?.documents || []).map((item, index) => ({
      ...item,
      name: item.title,
      url: "",
      kind: "document",
      label: "MD",
      attribute: ["data-document-index", index],
    })),
    ...(project?.settings?.grpcDefinitions || []).map((item) => ({
      ...item,
      kind: "grpc",
      label: "gRPC",
      url: item.target,
      attribute: ["data-grpc-definition", item.id],
    })),
    ...(project?.settings?.socketioDefinitions || []).map((item) => ({
      ...item,
      kind: "socketio",
      label: "Socket.IO",
      attribute: ["data-socketio-definition", item.id],
    })),
    ...(project?.protocols || []).map((item) => ({
      ...item,
      kind: item.type,
      label: item.type === "websocket" ? "WS" : item.type.toUpperCase(),
      attribute: ["data-protocol-id", item.id],
    })),
  ].filter(
    (item) =>
      (searchType === "all" || item.kind === searchType) &&
      (item.name + " " + (item.url || "") + " " + (item.folder || ""))
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
}

export function renderWorkspaceTree({
  project,
  search,
  searchType,
  page,
  current,
  activeDocumentId,
  selectedProtocolId,
  collapsedFolders,
}) {
  const isAPI = page === "apis";
  const items = workspaceTreeItems(project, search, searchType);
  const folders = [
    ...new Set([
      ...(project?.folders || []),
      ...items.map((item) => item.folder || ""),
    ]),
  ];
  const renderItem = (item, depth = 0) => {
    const [selector, identifier] = item.attribute;
    const active =
      (item.kind === "http" &&
        !activeDocumentId &&
        item.id === current &&
        isAPI) ||
      (item.kind === "document" &&
        activeDocumentId &&
        item.id === activeDocumentId &&
        isAPI) ||
      (item.kind !== "http" &&
        item.id === selectedProtocolId &&
        page === "protocols");
    return `<button type="button" class="tree-item${active ? " active" : ""}" ${active ? 'aria-current="true"' : ""} data-tree-kind="${esc(item.kind)}" data-tree-depth="${Math.min(depth, 4)}" ${selector}="${esc(identifier)}" title="${esc(item.name)}"><span class="method ${esc(item.method || item.label)}">${esc(item.label)}</span><span>${esc(item.name)}</span></button>`;
  };
  const renderFolder = (node, depth = 0) => {
    const path = node.path;
    const direct = items.filter((item) => (item.folder || "") === path);
    const total = items.filter(
      (item) =>
        (item.folder || "") === path ||
        (path && (item.folder || "").startsWith(path + "/")),
    ).length;
    const open = search || !collapsedFolders.has(project.id + ":" + path);
    const settings = path
      ? `<button type="button" class="ghost folder-edit" data-edit-folder="${esc(path)}" aria-label="编辑目录 ${esc(path)}"><span class="tree-folder-settings-label">设置</span>${isAPI ? icon("⚙") : ""}</button>`
      : "";
    return `<details class="tree-folder" data-tree-folder="${esc(path)}" ${open ? "open" : ""}><summary class="folder" data-tree-depth="${Math.min(depth, 4)}">${isAPI ? `<span class="tree-folder-caret" aria-hidden="true"></span>${icon("folder")}` : ""}<span class="tree-folder-name" title="${esc(node.name)}">${esc(node.name)}</span> <span class="tree-folder-count">(${total})</span>${settings}</summary>${direct.map((item) => renderItem(item, depth + 1)).join("")}${node.children.map((child) => renderFolder(child, depth + 1)).join("")}</details>`;
  };
  const root = items.filter((item) => !item.folder);
  const branches = folderTree(folders)
    .map((folder) => renderFolder(folder))
    .join("");
  const contents = isAPI
    ? root
        .filter(({ kind }) => kind === "document")
        .map((item) => renderItem(item))
        .join("") +
      branches +
      root
        .filter(({ kind }) => kind !== "document")
        .map((item) => renderItem(item))
        .join("")
    : branches +
      (root.length
        ? renderFolder({ path: "", name: "未分组", children: [] })
        : "");
  return contents || '<div class="notice">没有匹配的项目内容。</div>';
}
