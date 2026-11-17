// Pure bounded byte matching; no transport, timers, script engine or I/O.
export function normalizeTCPDelimiter(value) {
  if (typeof value !== "string" || !/^(?:[0-9a-fA-F]{2}){1,64}$/.test(value))
    throw Error("TCP 结束标记须为1至64字节的完整十六进制文本");
  return value.toLowerCase();
}

export function createTCPDelimiterMatcher(value) {
  const delimiter = Buffer.from(normalizeTCPDelimiter(value), "hex"),
    prefix = new Uint8Array(delimiter.length),
    received = Buffer.alloc(1048576);
  for (let i = 1, j = 0; i < delimiter.length; i++) {
    while (j && delimiter[i] !== delimiter[j]) j = prefix[j - 1];
    if (delimiter[i] === delimiter[j]) j++;
    prefix[i] = j;
  }
  let total = 0,
    matchedPrefix = 0,
    frameSize;
  return {
    push(chunk) {
      if (frameSize !== undefined) throw Error("TCP 结束标记已经匹配");
      if (!Buffer.isBuffer(chunk)) throw Error("TCP 响应分块须为字节");
      if (total + chunk.length > 1048576) throw Error("TCP 响应超过 1 MiB");
      const offset = total;
      received.set(chunk, offset);
      total += chunk.length;
      for (let i = offset; i < total; i++) {
        while (matchedPrefix && received[i] !== delimiter[matchedPrefix])
          matchedPrefix = prefix[matchedPrefix - 1];
        if (received[i] === delimiter[matchedPrefix]) matchedPrefix++;
        if (matchedPrefix === delimiter.length) {
          frameSize = i + 1;
          break;
        }
      }
      return frameSize !== undefined;
    },
    snapshot() {
      const end = frameSize ?? total;
      return {
        matched: frameSize !== undefined,
        frame: Buffer.from(received.subarray(0, end)),
        trailing: Buffer.from(received.subarray(end, total)),
      };
    },
  };
}

// Shared data-only evidence check. It cannot create or repair a historical record.
export function validateTCPDelimiterEvidence(definition, result) {
  const fail = () => {
    throw Error("TCP 结束标记证据无效");
  };
  const framing = result?.framing;
  if (
    definition?.completion !== "delimiter" ||
    !framing ||
    typeof framing !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(framing)) ||
    Object.keys(framing).sort().join(",") !==
      "matched,trailingBase64,trailingSize" ||
    typeof framing.matched !== "boolean" ||
    typeof result.partial !== "boolean" ||
    typeof result.timedOut !== "boolean"
  )
    fail();
  const decode = (value, size) => {
    if (
      typeof value !== "string" ||
      value.length > 1400000 ||
      !Number.isInteger(size) ||
      size < 0 ||
      size > 1048576
    )
      fail();
    const bytes = Buffer.from(value, "base64");
    if (bytes.length !== size || bytes.toString("base64") !== value) fail();
    return bytes;
  };
  const frame = decode(result.base64, result.size),
    tail = decode(framing.trailingBase64, framing.trailingSize),
    delimiter = Buffer.from(
      normalizeTCPDelimiter(definition.delimiterHex),
      "hex",
    ),
    position = frame.indexOf(delimiter);
  if (frame.length + tail.length > 1048576) fail();
  if (framing.matched) {
    if (
      position < 0 ||
      position + delimiter.length !== frame.length ||
      result.partial ||
      result.timedOut
    )
      fail();
  } else if (position !== -1 || tail.length || !result.partial) fail();
  return true;
}
