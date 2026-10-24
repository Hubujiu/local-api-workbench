const keys = new Set([
  "grpcCredentials",
  "socketioCredentials",
  "protocolCredentials",
]);
export async function readRuntimeCredentials(
  stream,
  { signal, timeoutMs = 30000 } = {},
) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000)
    throw Error("CLI 凭据读取期限无效");
  if (stream.isTTY)
    throw Error("CLI 临时凭据仅接受管道或重定向输入，不在交互终端读取");
  if (signal?.aborted) throw Error("CLI 临时凭据输入已取消");
  const abort = () => stream.destroy(Error("CLI 临时凭据输入已取消"));
  const timer = setTimeout(
    () => stream.destroy(Error("CLI 临时凭据输入超过期限")),
    timeoutMs,
  );
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 1024 * 1024) {
        stream.destroy();
        throw Error("CLI 临时凭据输入超过1MiB");
      }
      chunks.push(bytes);
    }
    let value;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
    } catch {
      throw Error("CLI 临时凭据必须是有效 UTF-8 JSON；未回显输入");
    }
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).some((key) => !keys.has(key))
    )
      throw Error("CLI 临时凭据只接受指定协议的步骤凭据映射");
    for (const map of Object.values(value))
      if (
        !map ||
        typeof map !== "object" ||
        Array.isArray(map) ||
        Object.getPrototypeOf(map) !== Object.prototype
      )
        throw Error("CLI 临时凭据必须按步骤ID映射");
    return value;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
