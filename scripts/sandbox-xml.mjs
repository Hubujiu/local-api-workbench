import { DOMParser } from "@xmldom/xmldom";
import { xmlToValue } from "../public/xml-value.js";
// Bundled into QuickJS: no DOM or host object is exposed to user scripts.
export function xml2Json(text) {
  if (arguments.length !== 1) throw Error("XML仅支持单个文本参数");
  return xmlToValue(text, DOMParser);
}
