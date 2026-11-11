import { MCPHTTPSessions } from "./mcp-http-sessions.mjs";
import { MCPWebSocketSessions } from "./mcp-websocket-sessions.mjs";
import { ProtocolSessions } from "./protocol-sessions.mjs";
import { createWireSessionRecorder } from "./wire-session-recorder.mjs";

// One isolated stdio launch, not the owner's HTTP server. Neither live HTTP
// config nor a client-supplied session/epoch can grant or revoke this identity.
export function createMCPStdioWebSocketSessions({ store, projects }) {
  const allowed = new Set(projects);
  const registry = new MCPHTTPSessions({ maxSessions: 1, idleMs: Infinity });
  const sessions = new ProtocolSessions({
    onFinish: createWireSessionRecorder(store),
  });
  const service = new MCPWebSocketSessions({
    sessions,
    store,
    owns: (owner) => registry.owns(owner),
  });
  registry.onDispose = (owner, reason) => service.dispose(owner, reason);
  let closing;
  return {
    registry,
    sessions,
    service: {
      sessions,
      call(action, owner, args) {
        // createMCP may add newly imported projects to its own collection. This
        // execution grant deliberately remains the explicit launch allowlist.
        if (!allowed.has(args?.projectId))
          throw Error("WebSocket project was not authorized at stdio startup");
        return service.call(action, owner, args);
      },
    },
    close() {
      registry.close();
      return (closing ??= Promise.all([registry.drain(), sessions.close()]));
    },
  };
}
