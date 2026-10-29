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
