import { DOMParser } from "@xmldom/xmldom";
// Bundled into QuickJS: neither DOM instances nor host objects escape this closure.
export function xml2Json(text) {
  if (arguments.length !== 1 || typeof text !== "string")
    throw Error("XML仅支持单个文本参数");
  let bytes = 0;
  for (const char of text) {
    const cp = char.codePointAt(0);
    bytes += cp <= 127 ? 1 : cp <= 2047 ? 2 : cp <= 65535 ? 3 : 4;
    if (bytes > 65536) throw Error("XML超过64 KiB");
  }
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text))
    throw Error("XML不允许DTD或实体声明");
  // Reject excessive element allocation before building a DOM; literal markup
  // inside comments, CDATA and processing instructions is not an element.
  const markup = text.replace(
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g,
    "",
  );
  if ((markup.match(/<(?![!?/])/g) || []).length > 10000)
    throw Error("XML超过节点上限");
  const document = new DOMParser({
    onError: (_level, message) => {
      throw Error("XML格式错误: " + message);
    },
  }).parseFromString(text, "application/xml");
  if (!document.documentElement) throw Error("XML没有根元素");
  let count = 0;
  const convert = (element, depth) => {
    if (++count > 10000 || depth > 32) throw Error("XML超过节点或深度上限");
    const result = Object.create(null);
    if (element.attributes.length) {
      const attrs = Object.create(null);
      for (let i = 0; i < element.attributes.length; i++) {
        if (++count > 10000) throw Error("XML超过节点上限");
        const attr = element.attributes.item(i);
        attrs[attr.name] = attr.value;
      }
      result.$ = attrs;
    }
    let content = "",
      hasChildren = false;
    const repeated = new Set();
    for (let child = element.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1) {
        hasChildren = true;
        const name = child.nodeName,
          value = convert(child, depth + 1);
        if (!Object.hasOwn(result, name)) result[name] = value;
        else if (repeated.has(name)) result[name].push(value);
        else {
          result[name] = [result[name], value];
          repeated.add(name);
        }
      } else {
        if (++count > 10000) throw Error("XML超过节点上限");
        if (child.nodeType === 3 || child.nodeType === 4)
          content += child.nodeValue;
        else if (![7, 8].includes(child.nodeType))
          throw Error("XML节点类型不支持");
      }
    }
    if (hasChildren && content.trim())
      throw Error("XML混合文本与子元素需手工处理");
    if (!hasChildren && !element.attributes.length) return content;
    if (!hasChildren && content) result._ = content;
    return result;
  };
  return {
    [document.documentElement.nodeName]: convert(document.documentElement, 1),
  };
}
