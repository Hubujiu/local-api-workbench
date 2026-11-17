import { parentPort, workerData } from "node:worker_threads";
import { DOMParser } from "@xmldom/xmldom";
import xpath from "xpath";
try {
  const document = new DOMParser({
    onError: (level, message) => {
      throw Error("XML 格式错误: " + message);
    },
  }).parseFromString(workerData.body, "application/xml");
  const result = xpath.useNamespaces(workerData.namespaces)(
    workerData.expression,
    document,
  );
  let value = result;
  if (Array.isArray(result)) {
    if (!result.length) throw Error("XPath 没有匹配节点");
    const node = result[0];
    value = node.nodeValue ?? node.textContent;
  }
  if (
    !["string", "number", "boolean"].includes(typeof value) ||
    (typeof value === "number" && !Number.isFinite(value))
  )
    throw Error("XPath 结果不是有限标量");
  if (Buffer.byteLength(JSON.stringify(value)) > 256 * 1024)
    throw Error("XPath 提取结果最多 256 KiB");
  parentPort.postMessage({ value });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
