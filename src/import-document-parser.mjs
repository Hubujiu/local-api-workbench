import { parse as parseYAML } from "yaml";

// Match the existing HTTP body / stdio frame ceiling. Those envelopes can impose
// a smaller effective document limit; this does not enlarge transport limits.
export const IMPORT_DOCUMENT_MAX_BYTES = 12 * 1024 * 1024;
export function parseImportDocumentText(text) {
  if (typeof text !== "string") throw Error("导入文本必须是字符串");
  if (Buffer.byteLength(text, "utf8") > IMPORT_DOCUMENT_MAX_BYTES)
    throw Error("导入文本超过12MiB");
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    result = parseYAML(text, { maxAliasCount: 100, uniqueKeys: true });
  }
  // Reference resolution intentionally treats examples/extensions as literal.
  // Bound the entire parsed graph here, including those literal subtrees.
  const active = new Set();
  const stack = [{ iterator: [result].values(), depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const frame = stack.at(-1);
    const next = frame.iterator.next();
    if (next.done) {
      if (frame.parent) active.delete(frame.parent);
      stack.pop();
      continue;
    }
    if (++nodes > 50000) throw Error("导入文本数据超过节点上限");
    if (frame.depth > 50) throw Error("导入文本数据层级过深");
    const value = next.value;
    if (value === null || typeof value !== "object") continue;
    if (active.has(value)) throw Error("导入文本不支持循环别名");
    active.add(value);
    stack.push({
      parent: value,
      iterator: Object.values(value).values(),
      depth: frame.depth + 1,
    });
  }
  return result;
}
