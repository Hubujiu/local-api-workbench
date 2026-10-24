# Independent MCP SDK interoperability evidence

Pin @modelcontextprotocol/sdk 1.32.1 (the official TypeScript SDK, MIT) as a development-only dependency. The production server and desktop runtime do not import it. Source package: https://www.npmjs.com/package/@modelcontextprotocol/sdk/v/1.32.1 ; upstream: https://github.com/modelcontextprotocol/typescript-sdk .

The integration tests use its actual Client, StreamableHTTPClientTransport and StdioClientTransport, not hand-written JSON-RPC messages or mocked transports. HTTP covers initialization/ping, validated tool discovery, allowed-project reads, cross-project refusal, absence of execution tools without grants, revoked old token rejection, reconnect with a new token, explicitly authorized execution against a loopback fixture, and disabled-service rejection. Stdio launches the real local server subprocess with one temporary fixture project, verifies discovery and isolation, and closes it through the SDK.

All test data, credentials and connections are temporary loopback fixtures. No external AI agent, account, project, or production system is contacted. The dependency is excluded from production dependency installation used for packaged apps. The root security audit includes its development dependency graph.

This supplies independent protocol-client evidence for the supported stateless JSON HTTP and stdio paths. It does not prove installation or UX compatibility in Cursor, Codex, Claude Code, VS Code, WorkBuddy or Trae. It does not add SSE server notifications, OAuth discovery, resumable sessions, execution cancellation, or full original Apipost tool argument/result equivalence. Those gaps remain explicit.

While exercising actual server data, a display mismatch was found: lastActivity is an activity object rather than a date string. The settings view now reads finishedAt or startedAt, with a failing regression first, so real activity no longer always appears absent.

## 参数契约补充

工具调用的 arguments 省略时仍按空对象处理；显式 null、布尔、数字、字符串和数组均拒绝。未知参数必须按 Schema 自有属性检查，不能把 **proto**、constructor 或 toString 等原型名称当成已声明参数。先失败回归证明修复前能够抵达工具操作；修复后校验失败不读写项目。此项不宣称曾发生原型污染或权限越权。
