import { parse as parseYAML } from "yaml";

// Match the existing HTTP body / stdio frame ceiling. Those envelopes can impose
// a smaller effective document limit; this does not enlarge transport limits.
export const IMPORT_DOCUMENT_MAX_BYTES = 12 * 1024 * 1024;
export function parseImportDocumentText(text) {
  if (typeof text !== "string") throw Error("导入文本必须是字符串");
  if (Buffer.byteLength(text, "utf8") > IMPORT_DOCUMENT_MAX_BYTES)
    throw Error("导入文本超过12MiB");
  try {
    return JSON.parse(text);
  } catch {
    return parseYAML(text, { maxAliasCount: 100, uniqueKeys: true });
  }
}
