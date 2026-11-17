import { Worker } from "node:worker_threads";
export function extractXML(body, expression, namespaces = {}) {
  if (typeof body !== "string" || Buffer.byteLength(body) > 1024 * 1024)
    throw Error("XML 提取响应最多 1 MiB");
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(body))
    throw Error("XML 提取禁止 DTD 和实体声明");
  if (
    typeof expression !== "string" ||
    !expression.trim() ||
    expression.length > 2000
  )
    throw Error("XPath 必须为 1–2000 字符");
  if (
    !namespaces ||
    typeof namespaces !== "object" ||
    Array.isArray(namespaces) ||
    Object.keys(namespaces).length > 32
  )
    throw Error("XML 命名空间必须是最多 32 项的映射");
  for (const [prefix, uri] of Object.entries(namespaces))
    if (
      !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(prefix) ||
      ["__proto__", "prototype", "constructor"].includes(prefix) ||
      typeof uri !== "string" ||
      uri.length > 2000
    )
      throw Error("XML 命名空间映射无效");
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./xml-extraction-worker.mjs", import.meta.url),
      {
        workerData: { body, expression, namespaces },
        resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 2 },
      },
    );
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(Error("XML/XPath 执行超时")), 2000);
    worker.once("message", (result) =>
      finish(result.error ? Error(result.error) : null, result.value),
    );
    worker.once("error", (error) => finish(error));
    worker.once("exit", () => {
      if (!settled) finish(Error("XML/XPath 执行进程已退出"));
    });
  });
}
