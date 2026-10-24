const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export function responseMediaEntries(content) {
  if (content === undefined) return [];
  if (!object(content)) throw Error("响应content必须是媒体类型映射");
  const entries = Object.entries(content);
  for (const [, media] of entries)
    if (!object(media)) throw Error("响应媒体定义必须是对象");
  return entries;
}
export function isResponseMediaType(type) {
  return (
    typeof type === "string" &&
    type.length <= 8192 &&
    !/[^\t\x20-\x7e\x80-\xff]/.test(type) &&
    /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(
      type.split(";")[0].trim(),
    )
  );
}
export function isJsonResponseType(type) {
  if (!isResponseMediaType(type)) return false;
  return /^[!#$%&'*+.^_`|~0-9a-z-]+\/(?:json|[!#$%&'*+.^_`|~0-9a-z-]+\+json)$/i.test(
    type.split(";")[0].trim(),
  );
}
export function selectJsonResponseMedia(content, predicate = () => true) {
  const entries = responseMediaEntries(content).filter(
    ([type, media]) => isJsonResponseType(type) && predicate(media),
  );
  return (
    entries.find(
      ([type]) =>
        type.split(";")[0].trim().toLowerCase() === "application/json",
    ) || entries[0]
  );
}
