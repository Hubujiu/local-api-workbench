// Portable source used inside the isolated script VM. Count first; do not allocate
// an encoding that the unchanged per-stage JSON quota will necessarily reject.
export function base64EncodingPreflight(input) {
  if (typeof input !== "string") throw Error("原版Base64加工链仅支持文本输入");
  let bytes = input.length;
  // Native regexp scan keeps the common ASCII case out of a per-character JS loop.
  if (/[^\x00-\x7f]/.test(input)) {
    bytes = 0;
    for (let i = 0; i < input.length; i++) {
      const cp = input.charCodeAt(i);
      if (cp >= 55296 && cp <= 56319) {
        const next = input.charCodeAt(i + 1);
        if (!(next >= 56320 && next <= 57343))
          throw Error("原版Base64仅支持有效Unicode文本和有效UTF-8编码结果");
        bytes += 4;
        i++;
      } else if (cp >= 56320 && cp <= 57343)
        throw Error("原版Base64仅支持有效Unicode文本和有效UTF-8编码结果");
      else bytes += cp <= 127 ? 1 : cp <= 2047 ? 2 : 3;
    }
  }
  // Standard Base64 is ASCII without JSON escapes. Include the two JSON quotes.
  // Validate the whole Unicode input before rejecting size, preserving error order.
  if (4 * Math.ceil(bytes / 3) + 2 > 65536)
    throw Error("原版函数模板结果超过64KiB");
}
