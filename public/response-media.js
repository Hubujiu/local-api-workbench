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
