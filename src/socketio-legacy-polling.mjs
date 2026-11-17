import { EventEmitter } from "node:events";
import { BoundedPolling } from "./socketio-polling.mjs";

// Reuse the same bounded HTTP acquisition and global request pool as EIO4.
// Engine.IO 3 remains responsible for length framing and base64 payload codecs.
export function boundLegacyPolling(transport) {
  const pending = new Set();
  let closing = false;
  transport.request = function (options = {}) {
    const emitter = new EventEmitter();
    let aborted = false;
    const adapter = {
      opts: {
        extraHeaders: transport.extraHeaders,
        ca: transport.ca,
        key: transport.key,
        cert: transport.cert,
      },
      requests: new Map(),
      get readyState() {
        return transport.readyState;
      },
      closing,
      uri: () => transport.uri(),
    };
    const entry = {
      closing,
      abort() {
        aborted = true;
        for (const request of adapter.requests.keys())
          request.destroy(Error("Legacy polling request cancelled"));
      },
    };
    emitter.abort = entry.abort;
    pending.add(entry);
    // Begin after the upstream transport has installed its event handlers.
    Promise.resolve()
      .then(() => {
        if (aborted) return;
        return BoundedPolling.prototype._fetch.call(
          adapter,
          options.method === "POST" ? options.data : undefined,
        );
      })
      .then(async (response) => {
        if (!response || aborted) return;
        const body = await response.text();
        if (aborted) return;
        emitter.emit("data", body);
        emitter.emit("success");
      })
      .catch((error) => {
        if (!aborted) emitter.emit("error", error);
      })
      .finally(() => pending.delete(entry));
    return emitter;
  };
  const close = transport.doClose,
    onClose = transport.onClose;
  transport.doClose = function () {
    closing = true;
    // No server session exists before a validated handshake. Do not POST a
    // close packet after malformed handshakes or pre-connect cancellation.
    if (!transport.socket?.id) return;
    return close.call(this);
  };
  transport.onClose = function (...args) {
    for (const entry of pending) if (!entry.closing) entry.abort();
    return onClose.apply(this, args);
  };
  return transport;
}
