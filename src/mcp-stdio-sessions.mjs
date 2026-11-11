import { createMCPStdioWebSocketSessions } from "./mcp-stdio-websocket.mjs";
import { MCPGrpcSessions } from "./mcp-grpc-sessions.mjs";
import { GrpcSessions } from "./grpc-sessions.mjs";
import { GrpcSlots } from "./grpc-slots.mjs";
import { executeGrpc } from "./grpc.mjs";

// One stdio launch owns the interactive protocols and a single shared pool for
// all its finite and interactive gRPC calls. This is not a cross-process grant.
export function createMCPStdioSessions({ store, projects }) {
  const websocket = createMCPStdioWebSocketSessions({ store, projects });
  const { registry } = websocket;
  const allowed = new Set(projects);
  const slots = new GrpcSlots();
  const grpcManager = new GrpcSessions({ store, slots });
  const grpcService = new MCPGrpcSessions({
    sessions: grpcManager,
    store,
    owns: (owner) => registry.owns(owner),
  });
  const finite = new Set();
  const shutdown = new AbortController();
  let closed = false,
    closing;
  const stopFinite = () => {
    closed = true;
    shutdown.abort();
  };
  const disposeWebSocket = registry.onDispose;
  registry.onDispose = (owner, reason) => {
    // Revoke admission and abort finite transport work synchronously, before any
    // store drain. Preserve the WebSocket hook instead of replacing its cleanup.
    stopFinite();
    return Promise.all([
      disposeWebSocket(owner, reason),
      grpcService.dispose(owner, reason),
      Promise.allSettled([...finite]),
    ]);
  };
  return {
    registry,
    websocketSessions: websocket.service,
    tcpSessions: websocket.tcpService,
    grpcManager,
    grpcSessions: {
      call(action, owner, args) {
        if (!allowed.has(args?.projectId))
          throw Error("gRPC project was not authorized at stdio startup");
        return grpcService.call(action, owner, args);
      },
    },
    async grpcExecutor(input, signal) {
      if (closed) throw Error("stdio gRPC execution ownership is closed");
      const release = slots.acquire();
      const combined = signal
        ? AbortSignal.any([signal, shutdown.signal])
        : shutdown.signal;
      // Track before transport admission, even if shutdown happens in this
      // microtask gap. executeGrpc checks the aborted signal before opening I/O.
      const task = Promise.resolve()
        .then(() => executeGrpc(input, combined))
        .finally(() => {
          release();
          finite.delete(task);
        });
      finite.add(task);
      return task;
    },
    close() {
      stopFinite();
      registry.close();
      return (closing ??= Promise.all([
        websocket.close(),
        grpcManager.close(),
        Promise.allSettled([...finite]),
      ]));
    },
  };
}
