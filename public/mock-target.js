export function mockURL(origin, projectId, requestId, index) {
  const url = new URL(
    `/mock/${encodeURIComponent(projectId)}/${encodeURIComponent(requestId)}`,
    origin,
  );
  if (!["http:", "https:"].includes(url.protocol))
    throw Error("Mock地址须为HTTP或HTTPS");
  if (index !== undefined) {
    if (!Number.isSafeInteger(index) || index < 0)
      throw Error("Mock示例索引无效");
    url.searchParams.set("example", String(index));
  }
  return url.href;
}
export function mockDebugTarget(origin, projectId, request, index) {
  if (
    index !== undefined &&
    (!Array.isArray(request.examples) ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= request.examples.length)
  )
    throw Error("Mock示例不存在");
  return {
    url: mockURL(origin, projectId, request.id, index),
    query: (request.query || []).map((item) =>
      index !== undefined && item.key === "example"
        ? { ...item, enabled: false }
        : { ...item },
    ),
  };
}
