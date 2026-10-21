const maps = [
  "folderParameters",
  "folderAuth",
  "folderScripts",
  "folderServices",
];
const within = (value, root) => value === root || value.startsWith(root + "/");
function validate(path) {
  if (
    typeof path !== "string" ||
    !path ||
    path.length > 500 ||
    /[\r\n\0]/.test(path) ||
    path
      .split("/")
      .some(
        (x) =>
          !x.trim() ||
          [".", "..", "__proto__", "prototype", "constructor"].includes(x),
      ) ||
    path.split("/").length > 32
  )
    throw Error("目录路径无效（最多32层）");
}
export function folderTree(paths) {
  const roots = [],
    nodes = new Map();
  for (const path of paths.filter(Boolean)) {
    // Existing odd names remain visible as flat labels; new moves are validated.
    let parts = path.split("/");
    try {
      validate(path);
    } catch {
      parts = [path];
    }
    let parent = roots,
      full = "";
    for (const name of parts) {
      full = full ? full + "/" + name : name;
      let node = nodes.get(full);
      if (!node) {
        node = { path: full, name, children: [] };
        nodes.set(full, node);
        parent.push(node);
      }
      parent = node.children;
    }
  }
  return roots;
}
export function moveFolderTree(project, previous, next) {
  validate(previous);
  if (next !== null) validate(next);
  if (next === previous) return structuredClone(project);
  if (next !== null && within(next, previous))
    throw Error("不能移入自己的子目录");
  const all = [
    ...(project.folders || []),
    ...(project.requests || []).map((x) => x.folder),
    ...(project.documents || []).map((x) => x.folder),
    ...(project.protocols || []).map((x) => x.folder),
    ...maps.flatMap((k) => Object.keys(project.settings?.[k] || {})),
  ].filter(Boolean);
  if (!all.some((path) => within(path, previous))) throw Error("源目录不存在");
  if (next !== null && all.some((x) => !within(x, previous) && within(x, next)))
    throw Error("目标目录已存在");
  const change = (path) =>
    within(path, previous)
      ? next === null
        ? ""
        : next + path.slice(previous.length)
      : path;
  for (const path of all.filter((x) => within(x, previous)))
    if (next !== null) validate(change(path));
  const result = structuredClone(project);
  result.folders = [
    ...new Set((result.folders || []).map(change).filter(Boolean)),
  ];
  if (next !== null && !result.folders.includes(next))
    result.folders.push(next);
  for (const key of ["requests", "documents", "protocols"])
    for (const item of result[key] || [])
      if (item.folder) item.folder = change(item.folder);
  result.settings ??= {};
  for (const key of maps)
    if (result.settings[key])
      result.settings[key] = Object.fromEntries(
        Object.entries(result.settings[key])
          .filter(([path]) => next !== null || !within(path, previous))
          .map(([path, value]) => [change(path), value]),
      );
  return result;
}
