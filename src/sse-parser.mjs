import { createParser } from "eventsource-parser";
export function validSSEHandshake(response) {
  return (
    response.status === 200 &&
    response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase() === "text/event-stream"
  );
}
// One parser and UTF-8 decoder per explicit connection. There is no reconnect,
// redirect, credential forwarding or shared Last-Event-ID state in this adapter.
export function boundedSSEParser(onEvent, { maxWireBytes = 1024 * 1024 } = {}) {
  let bytes = 0,
    lastId = "",
    retry,
    finished = false;
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const parser = createParser({
    maxBufferSize: 1024 * 1024,
    onId(id) {
      lastId = id;
    },
    onRetry(value) {
      if (Number.isSafeInteger(value) && value >= 0) retry = value;
    },
    onError(error) {
      if (error.type === "max-buffer-size-exceeded")
        throw Error("单个 SSE 事件超过 1 MiB 缓冲限制");
    },
    onEvent(event) {
      const value = {
        event: event.event || "message",
        id: lastId,
        data: event.data,
        ...(retry !== undefined ? { retry } : {}),
      };
      if (
        Buffer.byteLength(value.data) +
          Buffer.byteLength(value.id) +
          Buffer.byteLength(value.event) >
        1024 * 1024
      )
        throw Error("单个 SSE 事件超过 1 MiB");
      onEvent(value);
    },
  });
  return {
    feed(chunk) {
      if (finished) throw Error("SSE 解析器已结束");
      bytes += chunk.byteLength;
      if (bytes > maxWireBytes) throw Error("SSE 事件流超过字节上限");
      parser.feed(decoder.decode(chunk, { stream: true }));
    },
    finish() {
      if (finished) return;
      finished = true;
      parser.feed(decoder.decode());
      // EOF is not an event delimiter. Discard unfinished data, do not invent
      // a final blank line or dispatch a partially received event.
      parser.reset();
    },
  };
}
export function sseEventText(event) {
  return `event: ${event.event}\nid: ${event.id}\n${event.data
    .split("\n")
    .map((line) => "data: " + line)
    .join("\n")}`;
}
