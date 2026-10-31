import { nativeXMLPath } from "../src/native-xml-path.mjs";
import { DOMParser } from "@xmldom/xmldom";
import xpath from "xpath";
import { intrinsicGuard } from "./sandbox-intrinsic-guard.mjs";

export function createNativeXMLExtractor(response) {
  const checkIntrinsics = intrinsicGuard(),
    descriptor = Object.getOwnPropertyDescriptor,
    hasOwn = Object.hasOwn;
  const textSize = (text) => {
    if (typeof text !== "string" || text.length > 65536)
      throw Error("pickVars XML文本最多64KiB");
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(text))
      throw Error("pickVars XML包含无效XML字符");
    let bytes = 0;
    for (let at = 0; at < text.length; at++) {
      const code = text.charCodeAt(at);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(++at);
        if (!(next >= 0xdc00 && next <= 0xdfff))
          throw Error("pickVars XML文本包含无效Unicode");
        bytes += 4;
      } else if (code >= 0xdc00 && code <= 0xdfff)
        throw Error("pickVars XML文本包含无效Unicode");
      else bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
      if (bytes > 65536) throw Error("pickVars XML文本最多64KiB");
    }
  };
  return () => {
    checkIntrinsics();
    const body = descriptor(response, "body");
    if (
      !body?.enumerable ||
      !hasOwn(body, "value") ||
      typeof body.value !== "string"
    )
      throw Error("pickVars XML响应正文须为自有字符串数据");
    const text = body.value;
    textSize(text);
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text))
      throw Error("pickVars XML禁止DTD和实体声明");
    // Numeric references are not interpreted inside CDATA, comments or PIs.
    // This conservative markup preflight is not the XML parser; the mature
    // parser below remains responsible for validating the entire document.
    const markup = text.replace(
      /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g,
      "",
    );
    // xmldom intentionally recovers some invalid numeric references. Do not
    // allow that recovery to turn malformed XML into a successful token.
    const references = /&#(x[0-9a-fA-F]+|[0-9]+);/g;
    let reference;
    while ((reference = references.exec(markup))) {
      const point =
        reference[1][0] === "x"
          ? parseInt(reference[1].slice(1), 16)
          : parseInt(reference[1], 10);
      if (
        !(
          point === 9 ||
          point === 10 ||
          point === 13 ||
          (point >= 0x20 && point <= 0xd7ff) ||
          (point >= 0xe000 && point <= 0xfffd) ||
          (point >= 0x10000 && point <= 0x10ffff)
        )
      )
        throw Error("pickVars XML包含无效字符引用");
    }
    if ((markup.match(/<(?![!?/])/g) || []).length > 2000)
      throw Error("pickVars XML节点超过2000");
    let document;
    try {
      document = new DOMParser({
        onError() {
          throw Error("invalid XML");
        },
      }).parseFromString(text, "application/xml");
    } catch {
      throw Error("pickVars XML格式错误");
    }
    if (!document.documentElement) throw Error("pickVars XML没有根元素");
    let count = 0;
    const inspect = (node, depth) => {
      if (++count > 2000 || depth > 32)
        throw Error("pickVars XML节点或深度超限");
      if (node.nodeType === 1) {
        if (node.namespaceURI || node.prefix || node.nodeName.includes(":"))
          throw Error("pickVars XML暂不支持命名空间");
        for (let at = 0; at < node.attributes.length; at++) {
          const attribute = node.attributes.item(at);
          textSize(attribute.value);
          if (++count > 2000) throw Error("pickVars XML节点或属性超限");
          if (
            attribute.namespaceURI ||
            attribute.prefix ||
            attribute.name === "xmlns" ||
            attribute.name.includes(":")
          )
            throw Error("pickVars XML暂不支持命名空间");
        }
      } else if (node.nodeType === 3 || node.nodeType === 4)
        textSize(node.nodeValue);
      else if (![7, 8, 9].includes(node.nodeType))
        throw Error("pickVars XML节点类型不支持");
      for (let child = node.firstChild; child; child = child.nextSibling)
        inspect(child, depth + (child.nodeType === 1 ? 1 : 0));
    };
    inspect(document, 0);
    return (path) => {
      // A real library node-set query proves cardinality/type before the actual
      // scalar XPath call. No hand-written XML parser or XPath traversal engine.
      if (typeof path !== "string") throw Error("pickVars XML路径必须是字符串");
      nativeXMLPath("string(" + path + ")");
      const selected = xpath.select(path, document);
      if (!Array.isArray(selected) || selected.length !== 1)
        throw Error("pickVars XML路径须恰好匹配一个节点");
      const node = selected[0];
      if (node.nodeType !== 1 && node.nodeType !== 2)
        throw Error("pickVars XML路径只支持元素或属性");
      if (node.nodeType === 1)
        for (let child = node.firstChild; child; child = child.nextSibling)
          if (child.nodeType === 1) throw Error("pickVars XML元素必须是叶节点");
      const value = xpath.select("string(" + path + ")", document);
      if (typeof value !== "string")
        throw Error("pickVars XML结果须为字符串标量");
      textSize(value);
      return value;
    };
  };
}
