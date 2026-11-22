// The small metadata form cannot edit normalized SSE request options. Preserve
// only the SSE fields admitted by normalizeProtocol, and let the ordinary
// project save validate them again. Never carry them onto another target.
const sseFields = ["method", "body", "handshake", "templateMode", "duration"];

export function protocolDefinitionEdit(
  previous,
  { id, name, type, url, port },
) {
  const item = { id, name, type, url, port };
  if (!previous) return item;
  if (previous.id !== id) throw Error("连接定义已变化，请重新选择");
  if (previous.type !== "sse") return item;
  // Organization belongs to the definition, not its transport destination.
  if (previous.folder) item.folder = previous.folder;

  if (item.type !== "sse" || item.url !== previous.url) {
    const meaningful =
      (previous.method !== undefined && previous.method !== "GET") ||
      previous.body !== undefined ||
      previous.handshake !== undefined ||
      previous.templateMode !== undefined ||
      previous.duration !== undefined;
    if (meaningful)
      throw Error(
        "现有 SSE 定义包含本表单未展示的设置，不能更换地址或协议。原定义已保留，请重新加载项目后从新建菜单另建连接。",
      );
    return item;
  }
  for (const key of sseFields)
    if (Object.hasOwn(previous, key) && previous[key] !== undefined)
      item[key] = structuredClone(previous[key]);
  return item;
}
