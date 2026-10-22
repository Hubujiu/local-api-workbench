# Independent MCP SDK interoperability evidence

Pin @modelcontextprotocol/sdk 1.32.1 (the official TypeScript SDK, MIT) as a development-only dependency. The production server and desktop runtime do not import it. Source package: https://www.npmjs.com/package/@modelcontextprotocol/sdk/v/1.32.1 ; upstream: https://github.com/modelcontextprotocol/typescript-sdk .

The integration tests use its actual Client, StreamableHTTPClientTransport and StdioClientTransport, not hand-written JSON-RPC messages or mocked transports. HTTP covers initialization/ping, validated tool discovery, allowed-project reads, cross-project refusal, absence of execution tools without grants, revoked old token rejection, reconnect with a new token, explicitly authorized execution against a loopback fixture, and disabled-service rejection. Stdio launches the real local server subprocess with one temporary fixture project, verifies discovery and isolation, and closes it through the SDK.

All test data, credentials and connections are temporary loopback fixtures. No external AI agent, account, project, or production system is contacted. The dependency is excluded from production dependency installation used for packaged apps. The root security audit includes its development dependency graph.

This supplies independent protocol-client evidence for the supported stateless JSON HTTP and stdio paths. It does not prove installation or UX compatibility in Cursor, Codex, Claude Code, VS Code, WorkBuddy or Trae. It does not add SSE server notifications, OAuth discovery, resumable sessions, execution cancellation, or full original Apipost tool argument/result equivalence. Those gaps remain explicit.

While exercising actual server data, a display mismatch was found: lastActivity is an activity object rather than a date string. The settings view now reads finishedAt or startedAt, with a failing regression first, so real activity no longer always appears absent.
