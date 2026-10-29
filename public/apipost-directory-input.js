export const directorySettings = {
  custom_funcs: "custom_func",
  db_links: "db_link",
  marks: "marks",
  custom_attrs: "attributes",
  code_list: "codes",
  mock_custom_rules: "mock_custom_rules",
  desc_list: "describe_library",
};
export function allowedDirectoryPath(path) {
  return (
    typeof path === "string" &&
    path.length <= 300 &&
    ([
      "project.json",
      "global_params.json",
      "global_vars.json",
      "settings/mock_inner_rules.json",
    ].includes(path) ||
      /^executions\/(flows|runs)\/[A-Za-z0-9_-]+\.json$/.test(path) ||
      /^(apis|envs|samples|schemas)\/[A-Za-z0-9_-]+\.json$/.test(path) ||
      Object.keys(directorySettings).some(
        (key) => path === "settings/" + key + ".json",
      ))
  );
}
export async function selectedDirectoryDocument(
  selection,
  { shouldStop = () => false } = {},
) {
  const files = Array.from(selection || []);
  if (!files.length || files.length > 5000)
    throw Error("请选择原版项目目录，最多5000个JSON文件");
  let root,
    total = 0;
  const seen = new Set();
  const entries = files.map((file) => {
    const parts = String(file.webkitRelativePath || "").split("/");
    if (parts.length < 2 || !parts[0] || (root && root !== parts[0]))
      throw Error("请选择单个原版项目目录");
    root = parts.shift();
    const path = parts.join("/");
    if (!allowedDirectoryPath(path) || seen.has(path))
      throw Error(
        "目录包含未支持或重复文件: " + path + "；不会读取或忽略未知数据",
      );
    seen.add(path);
    if (!Number.isSafeInteger(file.size) || file.size < 0)
      throw Error("目录文件大小无效");
    total += file.size + path.length;
    if (total > 4 * 1024 * 1024) throw Error("Apipost目录JSON合计最多4MiB");
    return { file, path };
  });
  if (!seen.has("project.json"))
    throw Error("请选择含project.json的项目目录，不是上一级数据目录");
  const result = [];
  for (const { file, path } of entries) {
    if (shouldStop()) throw Error("目录读取已取消");
    const bytes = await file.arrayBuffer();
    if (shouldStop()) throw Error("目录读取已取消");
    if (bytes.byteLength !== file.size)
      throw Error("读取期间目录文件发生变化，请重新选择");
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw Error("目录文件不是有效UTF-8: " + path);
    }
    result.push({ path, text });
  }
  return { format: "apipost-offline-directory-v1", files: result };
}
