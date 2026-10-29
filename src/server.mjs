import { MCPHTTPSessions } from "./mcp-http-sessions.mjs";
import {
  writeDebugVariables,
  publishDebugVariables,
  clearDebugVariables,
} from "./debug-publication.mjs";
import { finalizeWireSession } from "./wire-session-evidence.mjs";
import { executeWireFlow } from "./wire-plan.mjs";
import { prepareWireExecution, makeWireRecord } from "./wire-evidence.mjs";
import { executeSocketIOFlow } from "./socketio-plan.mjs";
import { SocketIOSessions, normalizeSocketIODefinition } from "./socketio.mjs";
import { recordPlanRun } from "./plan-evidence.mjs";
import { reflectGrpc } from "./grpc-reflection.mjs";
import {
  inspectGrpcSchema,
  normalizeGrpcDefinition,
  executeGrpc,
} from "./grpc.mjs";
import {
  assertSDKCurlDefinition,
  sdkCurlDefinition,
} from "./script-url-export.mjs";
import { applySharedScripts } from "./shared-scripts.mjs";
import { DatabaseSessions } from "./database-sessions.mjs";
import { OAuth1Manager } from "./oauth1-flow.mjs";
import { applySharedAuth } from "./shared-auth.mjs";
import { applyGlobalParameters } from "./global-parameters.mjs";
import { projectCookieSession } from "./cookie-jar.mjs";
import { runLoad } from "./load-runner.mjs";
import { readMCPActivities } from "./mcp-activity.mjs";
import {
  resolveDynamicValue,
  resolveDynamicRequest,
} from "./dynamic-values.mjs";
import { previewFunction } from "./custom-functions.mjs";
import { parseErrorCodeList } from "./error-codes.mjs";
import { sampleProjectSchema, schemaMockResponse } from "./mock-fields.mjs";
import { scopedExecution, scopeMap } from "./variable-scopes.mjs";
import {
  parseParameterImport,
  previewParameterImport,
} from "./parameter-dictionary.mjs";
import { loadMCPConfig, saveMCPConfig } from "./mcp-config-store.mjs";
import { selectMockResponse } from "./mock.mjs";
import { snapshotCase } from "./cases.mjs";
import { versionPlan } from "./plan-version.mjs";
import {
  environmentVariables,
  selectedEnvironment,
  resolveServiceRequest,
  freezeServiceBinding,
  debugEnvironment,
  manageEnvironment,
} from "./environments.mjs";
import { createMCP } from "./mcp.mjs";
import { OAuthManager, exchangeOAuthToken } from "./oauth.mjs";
import { ProtocolSessions } from "./protocol-sessions.mjs";
import { queryRemoteDatabase } from "./remote-database.mjs";
import { mutatePostgres } from "./postgres-write.mjs";
import { mutateMySQL } from "./mysql-write.mjs";
import { mutateRedis } from "./redis.mjs";
import { captureSSE, exchangeTCP, exchangeWebSocket } from "./protocols.mjs";
import { querySQLiteBounded, mutateSQLiteBounded } from "./database.mjs";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import { Store, executeRequest } from "./runtime.mjs";
import {
  id,
  normalizeRequest,
  interpolate,
  importDocument,
  importIntoProject,
  exportOpenAPI,
  snapshotPlan,
  runPlan,
  toCurl,
  restoreProject,
} from "./core.mjs";
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
export async function createApp({
  root = process.env.LOCAL_API_DATA || ".local-api",
  port = Number(process.env.PORT) || 4318,
} = {}) {
  const requestedPort = port;
  const store = new Store(path.resolve(root));
  await store.init();
  const protocolSessions = new ProtocolSessions();
  const socketioSessions = new SocketIOSessions();
  const oauth = new OAuthManager();
  const oauth1 = new OAuth1Manager();
  const databaseSessions = new DatabaseSessions();
  const debugEnvironments = new Map();
  const mcpActivities = new Map();
  const mcpHTTPSessions = new MCPHTTPSessions();
  let mcp = { enabled: false, projects: [], write: false, execute: false },
    mcpToken = "",
    mcpLastActivity = null;
  const persistedMCP = await loadMCPConfig(path.resolve(root));
  let mcpWarning = persistedMCP?.warning || "";
  if (persistedMCP && !mcpWarning) {
    const {
      token: savedToken,
      port: savedPort,
      ...configuration
    } = persistedMCP;
    mcp = configuration;
    mcpToken = savedToken;
    if (port === 0) port = savedPort;
  }
  const token = randomBytes(32).toString("hex"),
    controllers = new Map();
  const claimRun = (candidate) => {
    const runId = candidate ?? id();
    if (
      typeof runId !== "string" ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(runId) ||
      controllers.has(runId)
    )
      throw Error("运行标识无效或正在使用");
    const controller = new AbortController();
    controllers.set(runId, controller);
    return { runId, controller };
  };
  let wireActive = 0;
  const withWireSlot = async (operation) => {
    if (wireActive >= 5) throw Error("最多同时执行5个通用协议调用");
    wireActive++;
    try {
      return await operation();
    } finally {
      wireActive--;
    }
  };
  const executePlanWire = (input, signal) =>
    withWireSlot(() => executeWireFlow(input, signal));
  let grpcActive = 0;
  const withGrpcTask = async (candidate, operation) => {
    const runId = candidate || id();
    if (
      typeof runId !== "string" ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(runId) ||
      controllers.has(runId)
    )
      throw Error("gRPC运行标识无效或正在使用");
    if (grpcActive >= 5) throw Error("最多同时执行5个gRPC调用");
    const controller = new AbortController();
    controllers.set(runId, controller);
    grpcActive++;
    try {
      return await operation(runId, controller.signal);
    } finally {
      controllers.delete(runId);
      grpcActive--;
    }
  };
  const executePlanGrpc = (input, parentSignal) =>
    withGrpcTask(undefined, (_id, childSignal) =>
      executeGrpc(
        input,
        parentSignal
          ? AbortSignal.any([parentSignal, childSignal])
          : childSignal,
      ),
    );
  let server;
  const json = (res, status, data) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  async function body(req) {
    let bytes = 0,
      chunks = [];
    for await (const c of req) {
      bytes += c.length;
      if (bytes > 12 * 1024 * 1024) throw Error("输入超过 12 MiB");
      chunks.push(c);
    }
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  }
  server = http.createServer(async (req, res) => {
    try {
      const base = `http://127.0.0.1:${server.address().port}`,
        host = req.headers.host;
      if (
        ![
          `127.0.0.1:${server.address().port}`,
          `localhost:${server.address().port}`,
        ].includes(host)
      )
        return json(res, 403, { error: "Host rejected" });
      const origin = req.headers.origin;
      if (
        origin &&
        ![base, `http://localhost:${server.address().port}`].includes(origin)
      )
        return json(res, 403, { error: "Origin rejected" });
      const u = new URL(req.url, base),
        parts = u.pathname.split("/").filter(Boolean);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      if (u.pathname === "/api/session" && req.method === "GET") {
        if (req.headers["x-local-token"] !== token)
          return json(res, 403, {
            error: "请使用启动时生成的本地链接打开工作台",
          });
        return json(res, 200, { token, version: "0.1.0" });
      }
      if (u.pathname === "/oauth/callback" && req.method === "GET") {
        await oauth.complete(Object.fromEntries(u.searchParams));
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "default-src 'none'",
        });
        return res.end(
          "<!doctype html><meta charset=utf-8><title>授权完成</title><p>授权完成。请回到 Local API 工作台；可以关闭此页。</p>",
        );
      }
      if (u.pathname === "/mcp") {
        if (!mcp.enabled || req.headers.authorization !== "Bearer " + mcpToken)
          return json(res, 403, { error: "MCP disabled or unauthorized" });
        const sessionHeader = req.headers["mcp-session-id"];
        if (sessionHeader !== undefined && !mcpHTTPSessions.get(sessionHeader))
          return json(res, 404, { error: "Unknown MCP session" });
        if (req.method === "DELETE" && sessionHeader !== undefined) {
          mcpHTTPSessions.delete(sessionHeader);
          res.writeHead(204);
          return res.end();
        }
        if (req.method !== "POST") {
          res.setHeader("Allow", "POST, DELETE");
          return json(res, 405, {
            error: "Only POST and session DELETE are supported",
          });
        }
        const requestEpoch = mcpHTTPSessions.capture();
        const incomingToken = mcpToken;
        const message = await body(req);
        if (
          requestEpoch !== mcpHTTPSessions.capture() ||
          incomingToken !== mcpToken
        )
          return json(res, 403, { error: "MCP authorization changed" });
        if (sessionHeader !== undefined && !mcpHTTPSessions.get(sessionHeader))
          return json(res, 404, { error: "Unknown MCP session" });
        if (!message || Array.isArray(message) || message.jsonrpc !== "2.0")
          return json(res, 400, { error: "Invalid JSON-RPC request" });
        let sessionId = sessionHeader;
        if (message.method === "initialize" && message.id !== undefined) {
          if (sessionId !== undefined)
            return json(res, 400, { error: "Session already initialized" });
          sessionId = mcpHTTPSessions.create(message.id);
          res.setHeader("Mcp-Session-Id", sessionId);
        }
        if (
          message.method === "notifications/cancelled" &&
          message.id === undefined
        ) {
          if (sessionId !== undefined)
            mcpHTTPSessions.cancel(sessionId, message.params?.requestId);
          res.writeHead(202);
          return res.end();
        }
        const cancellable =
          message.method === "tools/call" &&
          [
            "localapi_execute_api",
            "localapi_execute_flow",
            "localapi_run_plan",
            "apipost_execute_api",
            "apipost_execute_flow",
          ].includes(message.params?.name);
        const execution =
          sessionId !== undefined && message.id !== undefined
            ? mcpHTTPSessions.begin(sessionId, message.id, cancellable)
            : { signal: undefined, finish() {} };
        const activityId = id();
        if (message.method === "tools/call") {
          const active = [...mcpActivities.values()].filter(
            (a) => a.status === "running",
          );
          if (active.length >= 10) {
            execution.finish();
            return json(res, 429, { error: "MCP并发任务达到上限" });
          }
          mcpActivities.set(activityId, {
            id: activityId,
            tool: message.params?.name,
            projectId:
              message.params?.arguments?.projectId ??
              message.params?.arguments?.project_id,
            planId:
              message.params?.arguments?.planId ??
              message.params?.arguments?.flow_id,
            status: "running",
            startedAt: new Date().toISOString(),
            completed: 0,
          });
        }
        let result;
        try {
          const dispatch = createMCP({
            store,
            ...mcp,
            debugEnvironments,
            grpcExecutor: executePlanGrpc,
            protocolExecutor: executePlanWire,
            socketioExecutor: (projectId, input, signal) =>
              executeSocketIOFlow(input, signal, {
                projectId,
                sessions: socketioSessions,
              }),
            onProgress: (progress) => {
              const activity = mcpActivities.get(activityId);
              if (activity)
                Object.assign(activity, { ...progress, status: "running" });
            },
          });
          result = await dispatch(message, { signal: execution.signal });
        } catch {
          result = {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "MCP执行异常；请检查活动与历史，不要自动重放",
                },
              ],
            },
          };
        } finally {
          execution.finish();
        }
        if (message.method === "tools/call") {
          const activity = mcpActivities.get(activityId);
          let output;
          try {
            output = JSON.parse(result?.result?.content?.[0]?.text);
          } catch {}
          const outcome = cancellable ? output?.status : undefined;
          const recordSaved = cancellable
            ? (output?.recordSaved ?? output?.record_saved)
            : undefined;
          Object.assign(activity, {
            status:
              recordSaved === false
                ? "failed"
                : outcome === "cancelled"
                  ? "cancelled"
                  : result?.result?.isError || outcome === "failed"
                    ? "failed"
                    : "completed",
            ...(typeof recordSaved === "boolean" ? { recordSaved } : {}),
            ...(recordSaved === false
              ? {
                  executionStatus: outcome,
                  persistenceError:
                    "执行记录保存失败，请检查项目存储；不会重新执行请求",
                }
              : {}),
            finishedAt: new Date().toISOString(),
          });
          mcpLastActivity = activity;
          if (
            mcp.remember &&
            message.params?.name === "localapi_create_project" &&
            !result?.result?.isError
          )
            await saveMCPConfig(path.resolve(root), {
              ...mcp,
              token: mcpToken,
              port: server.address().port,
            });
          const completed = [...mcpActivities.values()].filter(
            (a) => a.status !== "running",
          );
          for (const old of completed.slice(
            0,
            Math.max(0, completed.length - 20),
          ))
            mcpActivities.delete(old.id);
        }
        if (result === null || execution.cancelledByNotification) {
          res.writeHead(202);
          return res.end();
        }
        if (requestEpoch !== mcpHTTPSessions.capture())
          return json(res, 200, {
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32000,
              message:
                "MCP authorization changed; inspect authorized history for operation outcome",
            },
          });
        return json(res, 200, result);
      }
      if (parts[0] === "mock") {
        const p = await store.get(parts[1]),
          r = p.requests.find((r) => r.id === parts[2] && !r.deletedAt);
        if (!r) return json(res, 404, { error: "Mock not found" });
        if (p.settings?.mockEnabled === false)
          return json(res, 503, { error: "Mock服务已关闭" });
        const chunks = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 8 * 1024 * 1024) throw Error("Mock请求体超过8MiB");
          chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks).toString("utf8");
        let incoming = raw;
        try {
          incoming = JSON.parse(raw);
        } catch {}
        if (u.searchParams.getAll("example").length > 1)
          throw Error("Mock示例索引不能重复");
        const selected = selectMockResponse(
          r,
          {
            method: req.method,
            query: Object.fromEntries(u.searchParams),
            headers: req.headers,
            body: incoming,
          },
          () => schemaMockResponse(p, r),
        );
        if (selected.delayMs)
          await new Promise((resolve) => setTimeout(resolve, selected.delayMs));
        res.writeHead(selected.status, {
          "Content-Type": "application/json",
          ...selected.headers,
          "Content-Security-Policy":
            "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
        });
        return res.end(
          [204, 205, 304].includes(selected.status) ? "" : selected.body,
        );
      }
      if (parts[0] === "api") {
        if (req.headers["x-local-token"] !== token)
          return json(res, 403, { error: "Session token required" });
        if (u.pathname === "/api/protocol-sessions" && req.method === "POST") {
          const input = await body(req);
          if (input.projectId !== undefined)
            throw Error("项目会话请使用项目专属入口");
          return json(res, 200, protocolSessions.start(input));
        }
        if (parts[1] === "protocol-sessions" && parts[2]) {
          if (protocolSessions.get(parts[2]).projectId)
            throw Error("项目会话不能通过全局入口访问");
          if (req.method === "GET")
            return json(res, 200, protocolSessions.snapshot(parts[2]));
          const data = await body(req);
          if (parts[3] === "send")
            return json(
              res,
              200,
              protocolSessions.send(parts[2], data.message),
            );
          if (parts[3] === "stop") {
            protocolSessions.stop(parts[2]);
            return json(res, 200, protocolSessions.snapshot(parts[2]));
          }
        }
        if (u.pathname === "/api/oauth1/start" && req.method === "POST")
          return json(res, 200, await oauth1.start(await body(req)));
        if (u.pathname === "/api/oauth1/complete" && req.method === "POST")
          return json(res, 200, await oauth1.complete(await body(req)));
        if (u.pathname === "/api/oauth/start" && req.method === "POST")
          return json(res, 200, oauth.start(await body(req), base));
        if (
          parts[1] === "oauth" &&
          parts[2] === "status" &&
          req.method === "GET"
        )
          return json(res, 200, oauth.status(parts[3]));
        if (u.pathname === "/api/oauth/token" && req.method === "POST") {
          const config = await body(req);
          const grant =
            config.grantType === "refresh_token"
              ? {
                  grant_type: "refresh_token",
                  refresh_token: config.refreshToken,
                }
              : { grant_type: "client_credentials" };
          return json(res, 200, await exchangeOAuthToken(config, grant));
        }
        if (u.pathname === "/api/mcp/config") {
          if (req.method === "POST") {
            const config = await body(req);
            if (!Array.isArray(config.projects))
              throw Error("项目授权列表无效");
            const existing = new Set(
              (await store.list()).map((project) => project.id),
            );
            if (config.projects.some((id) => !existing.has(id)))
              throw Error("不能授权不存在的项目");
            const next = {
              enabled: config.enabled === true,
              remember: config.remember === true,
              projects: config.projects,
              write: config.write === true,
              execute: config.write === true && config.execute === true,
            };
            const nextToken = next.enabled
              ? !mcpToken || config.rotate === true
                ? randomBytes(32).toString("hex")
                : mcpToken
              : "";
            await saveMCPConfig(path.resolve(root), {
              ...next,
              token: nextToken,
              port: server.address().port,
            });
            mcpHTTPSessions.advance({
              dropSessions: !next.enabled || nextToken !== mcpToken,
            });
            mcp = next;
            mcpToken = nextToken;
            mcpWarning = "";
          } else if (req.method !== "GET")
            return json(res, 405, { error: "Method not allowed" });
          return json(res, 200, {
            ...mcp,
            endpoint: base + "/mcp",
            dataRoot: store.root,
            warning: mcpWarning,
            token: mcpToken,
            lastActivity: mcpLastActivity,
            activities: [
              ...mcpActivities.values(),
              ...(await readMCPActivities(store.root)),
            ],
          });
        }
        if (u.pathname === "/api/projects" && req.method === "GET")
          return json(res, 200, await store.list());
        if (u.pathname === "/api/projects" && req.method === "POST") {
          const b = await body(req);
          return json(res, 201, await store.create(b.name, b.directory));
        }
        if (u.pathname === "/api/restore" && req.method === "POST") {
          const b = await body(req);
          const restored = restoreProject(b.document);
          await store.save(restored);
          return json(res, 201, restored);
        }
        if (u.pathname === "/api/cancel" && req.method === "POST") {
          const b = await body(req);
          controllers.get(b.id)?.abort();
          return json(res, 200, { ok: true });
        }
        if (parts[1] === "projects" && parts[2]) {
          const p = await store.get(parts[2]);
          const action = parts[3];
          if (action === "cookies") {
            const b = req.method === "POST" ? await body(req) : {};
            const jar = projectCookieSession(
              store,
              p,
              b.environmentId || u.searchParams.get("environmentId"),
            );
            if (req.method === "POST") {
              if (b.operation === "configure") await jar.configure(b);
              else if (b.operation === "set")
                await jar.setCookie(b.url, b.cookie, b);
              else if (b.operation === "remove") await jar.remove(b);
              else if (b.operation === "clear") await jar.clear(b);
              else throw Error("未知Cookie操作");
            } else if (req.method !== "GET") throw Error("Cookie方法无效");
            return json(res, 200, await jar.inspect());
          }

          if (action === "error-codes-preview" && req.method === "POST") {
            const data = await body(req);
            return json(res, 200, { codes: parseErrorCodeList(data.source) });
          }
          if (
            action === "debug-variables" &&
            ["GET", "PUT"].includes(req.method)
          ) {
            const data = req.method === "PUT" ? await body(req) : {};
            const context = debugEnvironment(
              p,
              data.environmentId || u.searchParams.get("environmentId"),
              debugEnvironments,
            );
            const runtimeFingerprint = createHash("sha256")
              .update(JSON.stringify(context.variables))
              .digest("hex");
            if (req.method === "PUT") {
              if (data.runtimeFingerprint !== runtimeFingerprint)
                throw Error("运行时变量已变化，请重新读取");
              if (data.fingerprint !== context.fingerprint)
                throw Error("环境变量已变化，请重新读取运行时变量");
              if (!data.variables || Object.keys(data.variables).length > 10000)
                throw Error("运行时变量最多10000项");
              const variables = scopeMap(data.variables);
              writeDebugVariables(debugEnvironments, p.id, context.cacheKey, {
                fingerprint: context.fingerprint,
                variables,
              });
              return json(res, 200, { ok: true });
            }
            return json(res, 200, {
              environmentId: context.environment.id,
              fingerprint: context.fingerprint,
              runtimeFingerprint,
              variables: context.variables,
            });
          }
          if (action === "clear-session" && req.method === "POST") {
            clearDebugVariables(debugEnvironments, p.id);
            return json(res, 200, { ok: true });
          }
          if (action === "location" && req.method === "GET")
            return json(res, 200, { path: store.file(p.id) });
          if (!action && req.method === "GET") return json(res, 200, p);
          if (!action && req.method === "PUT") {
            const b = await body(req);
            if (b.id !== p.id) throw Error("项目 ID 不匹配");
            if (
              !Array.isArray(b.requests) ||
              !Array.isArray(b.environments) ||
              !Array.isArray(b.plans)
            )
              throw Error("无效项目结构");
            if (
              b.environments.some(
                (environment) =>
                  !environment ||
                  typeof environment.id !== "string" ||
                  !environment.variables ||
                  typeof environment.variables !== "object" ||
                  Array.isArray(environment.variables),
              )
            )
              throw Error("环境变量必须是对象");
            if (!Array.isArray(b.documents) || !Array.isArray(b.dictionary))
              throw Error("文档或数据字典格式无效");
            if (
              b.documents.some(
                (document) =>
                  !document ||
                  typeof document.title !== "string" ||
                  typeof document.content !== "string",
              )
            )
              throw Error("文档格式无效");
            b.requests = b.requests.map(normalizeRequest);
            b.plans = b.plans.map((plan) =>
              versionPlan(
                p.plans.find((old) => old.id === plan.id),
                plan,
                "manual",
                b,
              ),
            );
            if (b.archived)
              mcp.projects = mcp.projects.filter((id) => id !== b.id);
            b.runs = p.runs;
            b.history = p.history;
            const saved = await store.save(b);
            if (b.archived && mcp.remember)
              await saveMCPConfig(path.resolve(root), {
                ...mcp,
                token: mcpToken,
                port: server.address().port,
              });
            return json(res, 200, saved);
          }
          if (action === "import" && req.method === "POST") {
            const b = await body(req);
            importIntoProject(p, b.document);
            await store.save(p);
            return json(res, 200, p);
          }
          if (action === "export" && req.method === "GET")
            return json(
              res,
              200,
              u.searchParams.get("format") === "openapi" ? exportOpenAPI(p) : p,
            );
          if (action === "grpc-reflection" && req.method === "POST") {
            const { runId, ...input } = await body(req);
            return await withGrpcTask(runId, async (runId, signal) =>
              json(res, 200, { ...(await reflectGrpc(input, signal)), runId }),
            );
          }
          if (action === "grpc-schema" && req.method === "POST")
            return json(res, 200, inspectGrpcSchema(await body(req)));
          if (action === "grpc-definitions") {
            const definitions = p.settings.grpcDefinitions || [];
            if (req.method === "GET") return json(res, 200, definitions);
            if (req.method === "POST") {
              const definition = normalizeGrpcDefinition(await body(req));
              const index = definitions.findIndex(
                (item) => item.id === definition.id,
              );
              const next = definitions.slice();
              if (index < 0) next.push(definition);
              else next[index] = definition;
              p.settings.grpcDefinitions = next;
              await store.save(p);
              return json(res, 200, {
                definition,
                projectRevision: p.revision,
              });
            }
            if (req.method === "DELETE") {
              const data = await body(req);
              if (!definitions.some((item) => item.id === data.id))
                throw Error("gRPC定义不存在");
              p.settings.grpcDefinitions = definitions.filter(
                (item) => item.id !== data.id,
              );
              await store.save(p);
              return json(res, 200, { deleted: true });
            }
          }
          if (action === "socketio-definitions") {
            const definitions = p.settings.socketioDefinitions || [];
            if (req.method === "GET") return json(res, 200, definitions);
            if (req.method === "POST") {
              const definition = normalizeSocketIODefinition(await body(req));
              const next = definitions.slice(),
                index = next.findIndex((x) => x.id === definition.id);
              if (index < 0) next.push(definition);
              else next[index] = definition;
              p.settings.socketioDefinitions = next;
              await store.save(p);
              return json(res, 200, {
                definition,
                projectRevision: p.revision,
              });
            }
            if (req.method === "DELETE") {
              const { id: definitionId } = await body(req);
              if (!definitions.some((x) => x.id === definitionId))
                throw Error("Socket.IO定义不存在");
              p.settings.socketioDefinitions = definitions.filter(
                (x) => x.id !== definitionId,
              );
              await store.save(p);
              return json(res, 200, { deleted: true });
            }
          }
          if (action === "socketio-runs" && req.method === "GET")
            return json(
              res,
              200,
              (p.protocolRuns || []).filter((x) => x.type === "socketio"),
            );
          if (action === "socketio-sessions") {
            const sessionId = parts[4],
              operation = parts[5];
            if (req.method === "GET")
              return json(
                res,
                200,
                sessionId
                  ? socketioSessions.snapshot(p.id, sessionId)
                  : socketioSessions.list(p.id),
              );
            if (req.method === "POST") {
              const data = await body(req);
              if (!sessionId) {
                if (
                  Object.keys(data).some(
                    (k) =>
                      ![
                        "definitionId",
                        "auth",
                        "query",
                        "headers",
                        "tls",
                        "connectTimeoutMs",
                        "transport",
                      ].includes(k),
                  )
                )
                  throw Error("Socket.IO连接字段无效，目标须通过定义保存");
                const definition = (p.settings.socketioDefinitions || []).find(
                  (x) => x.id === data.definitionId,
                );
                if (!definition) throw Error("Socket.IO定义不存在");
                const { definitionId, ...input } = data;
                return json(
                  res,
                  200,
                  socketioSessions.start(p.id, { ...definition, ...input }),
                );
              }
              if (operation === "send")
                return json(
                  res,
                  200,
                  await socketioSessions.send(p.id, sessionId, data),
                );
              if (operation === "ack")
                return json(
                  res,
                  200,
                  socketioSessions.acknowledge(p.id, sessionId, data),
                );
              if (operation === "watch") {
                if (Object.keys(data).some((k) => k !== "events"))
                  throw Error("Socket.IO监听字段无效");
                return json(
                  res,
                  200,
                  socketioSessions.watch(p.id, sessionId, data.events),
                );
              }
              if (operation === "stop") {
                if (Object.keys(data).length)
                  throw Error("Socket.IO停止不接受额外字段");
                const session = socketioSessions.get(p.id, sessionId),
                  result = socketioSessions.stop(p.id, sessionId);
                if (session.recordSaved)
                  return json(res, 200, {
                    ...result,
                    recordSaved: true,
                    recordId: sessionId,
                  });
                session.recordPromise ||= (async () => {
                  const record = {
                    id: sessionId,
                    type: "socketio",
                    createdAt: result.createdAt,
                    definition: result.definition,
                    result,
                    source: "manual",
                    status:
                      result.state === "error" ||
                      result.events.some((x) =>
                        ["ack-timeout", "disconnected"].includes(x.direction),
                      )
                        ? "failed"
                        : result.connected
                          ? "passed"
                          : "cancelled",
                  };
                  try {
                    await store.append(p.id, "protocolRuns", record);
                    session.recordSaved = true;
                    return {
                      ...result,
                      recordSaved: true,
                      recordId: sessionId,
                    };
                  } catch (error) {
                    return {
                      ...result,
                      recordSaved: false,
                      recordId: null,
                      persistenceError: error.message,
                    };
                  }
                })();
                const recorded = await session.recordPromise;
                if (!session.recordSaved) session.recordPromise = null;
                return json(res, 200, recorded);
              }
            }
          }
          if (action === "grpc-runs" && req.method === "GET")
            return json(
              res,
              200,
              (p.protocolRuns || []).filter((item) => item.type === "grpc"),
            );
          if (action === "grpc-run" && req.method === "POST") {
            const data = await body(req);
            if (
              Object.keys(data).some(
                (key) =>
                  ![
                    "definitionId",
                    "service",
                    "method",
                    "timeoutMs",
                    "messages",
                    "metadata",
                    "tls",
                    "runId",
                  ].includes(key),
              )
            )
              throw Error("gRPC执行字段无效，地址及proto须通过定义保存");
            const source = (p.settings.grpcDefinitions || []).find(
              (item) => item.id === data.definitionId,
            );
            if (!source) throw Error("gRPC定义不存在");
            const definition = normalizeGrpcDefinition({
              ...source,
              ...Object.fromEntries(
                ["service", "method", "timeoutMs"]
                  .filter((key) => data[key] !== undefined)
                  .map((key) => [key, data[key]]),
              ),
            });
            return await withGrpcTask(data.runId, async (runId, signal) => {
              const request = Object.fromEntries(
                [
                  "target",
                  "proto",
                  "files",
                  "protoName",
                  "schema",
                  "service",
                  "method",
                  "timeoutMs",
                ]
                  .filter((key) => definition[key] !== undefined)
                  .map((key) => [key, definition[key]]),
              );
              const result = await executeGrpc(
                {
                  ...request,
                  ...Object.fromEntries(
                    ["messages", "metadata", "tls"]
                      .filter((key) => data[key] !== undefined)
                      .map((key) => [key, data[key]]),
                  ),
                },
                signal,
              );
              const record = {
                id: result.id,
                runId,
                type: "grpc",
                createdAt: new Date().toISOString(),
                definition,
                definitionHash: createHash("sha256")
                  .update(JSON.stringify(definition))
                  .digest("hex"),
                requestMessages: structuredClone(data.messages ?? [{}]),
                result: { ...result, metadata: [], trailers: [] },
                status:
                  result.status.code === 0
                    ? "passed"
                    : result.status.code === 1
                      ? "cancelled"
                      : "failed",
              };
              try {
                await store.append(p.id, "protocolRuns", record);
              } catch (error) {
                return json(res, 200, {
                  ...result,
                  runId,
                  recordId: null,
                  recordSaved: false,
                  persistenceError: String(error.message).slice(0, 500),
                });
              }
              return json(res, 200, {
                ...result,
                runId,
                recordId: record.id,
                recordSaved: true,
              });
            });
          }
          if (action === "protocol-sessions") {
            const sessionId = parts[4],
              operation = parts[5];
            if (!sessionId && req.method === "POST") {
              const input = await body(req);
              if (
                [
                  "duration",
                  "maxEvents",
                  "maxMessages",
                  "runId",
                  "projectId",
                ].some((key) => input[key] !== undefined)
              )
                throw Error("交互协议会话使用固定生命周期，不接受单次捕获选项");
              const prepared = prepareWireExecution(p, input),
                result = protocolSessions.start(prepared.request),
                session = protocolSessions.get(result.id);
              session.projectId = p.id;
              session.definition = prepared.definition;
              return json(res, 200, {
                ...protocolSessions.snapshot(session.id),
                projectId: p.id,
                recordSaved: false,
              });
            }
            const session = protocolSessions.get(sessionId);
            if (session.projectId !== p.id)
              throw Error("协议会话不存在或不属于此项目");
            if (req.method === "GET" && !operation)
              return json(res, 200, {
                ...protocolSessions.snapshot(sessionId),
                projectId: p.id,
                recordSaved: session.recordSaved === true,
                ...(session.recordSaved ? { recordId: sessionId } : {}),
              });
            if (req.method !== "POST") throw Error("协议会话操作无效");
            const input = await body(req);
            if (operation === "send") {
              if (Object.keys(input).some((key) => key !== "message"))
                throw Error("协议会话发送字段无效");
              const message =
                input.message !== undefined
                  ? input.message
                  : (session.definition.message ?? "");
              return json(res, 200, {
                ...protocolSessions.send(sessionId, message),
                projectId: p.id,
              });
            }
            if (operation === "stop") {
              if (Object.keys(input).length)
                throw Error("协议停止不接受额外字段");
              protocolSessions.stop(sessionId);
              session.finalSnapshot ??= protocolSessions.snapshot(sessionId);
              if (session.recordSaved)
                return json(res, 200, {
                  ...session.finalSnapshot,
                  projectId: p.id,
                  recordSaved: true,
                  recordId: sessionId,
                });
              const pending = (session.recordPromise ??= (async () => {
                try {
                  const recordId = await finalizeWireSession(
                    store,
                    p.id,
                    session,
                    session.finalSnapshot,
                  );
                  session.recordSaved = true;
                  return {
                    ...session.finalSnapshot,
                    projectId: p.id,
                    recordSaved: true,
                    recordId,
                  };
                } catch (error) {
                  return {
                    ...session.finalSnapshot,
                    projectId: p.id,
                    recordSaved: false,
                    recordId: null,
                    persistenceError: String(error.message).slice(0, 500),
                  };
                }
              })());
              const result = await pending;
              if (!result.recordSaved && session.recordPromise === pending)
                session.recordPromise = null;
              return json(res, 200, result);
            }
            throw Error("未知协议会话操作");
          }
          if (action === "protocol-runs" && req.method === "GET") {
            const type = u.searchParams.get("type");
            if (
              type &&
              !["tcp", "websocket", "sse", "grpc", "socketio"].includes(type)
            )
              throw Error("未知协议记录类型");
            return json(
              res,
              200,
              (p.protocolRuns || []).filter(
                (record) => !type || record.type === type,
              ),
            );
          }
          if (action === "protocol" && req.method === "POST") {
            const input = await body(req),
              prepared = prepareWireExecution(p, input);
            const fn = {
              sse: captureSSE,
              tcp: exchangeTCP,
              websocket: exchangeWebSocket,
            }[prepared.definition.type];
            const { controller, runId } = claimRun(input.runId),
              startedAt = Date.now();
            let result, error;
            try {
              try {
                result = await withWireSlot(() =>
                  fn(prepared.request, controller.signal),
                );
              } catch (failure) {
                error = failure;
              }
              let recordId = null,
                persistenceError;
              try {
                const record = makeWireRecord(
                  prepared,
                  runId,
                  startedAt,
                  result,
                  error,
                  controller.signal.aborted,
                );
                await store.append(p.id, "protocolRuns", record);
                recordId = record.id;
              } catch (failure) {
                persistenceError = String(failure.message).slice(0, 500);
              }
              return json(res, error ? 400 : 200, {
                ...(result || {}),
                ...(error ? { error: error.message } : {}),
                runId,
                recordId,
                recordSaved: Boolean(recordId),
                ...(persistenceError ? { persistenceError } : {}),
              });
            } finally {
              controllers.delete(runId);
            }
          }
          if (action === "database-connections") {
            if (req.method === "GET")
              return json(res, 200, databaseSessions.list(p.id));
            if (req.method === "POST")
              return json(
                res,
                200,
                databaseSessions.register(p.id, await body(req)),
              );
            if (req.method === "DELETE") {
              databaseSessions.revoke(p.id, (await body(req)).id);
              return json(res, 200, { revoked: true });
            }
          }
          if (action === "database" && req.method === "POST") {
            const b = await body(req);
            if (b.allowWrite !== undefined && typeof b.allowWrite !== "boolean")
              throw Error("写入标识必须为布尔值");
            if (b.allowWrite === true) {
              if (b.type === "postgres")
                return json(res, 200, await mutatePostgres(b));
              if (b.type === "mysql")
                return json(res, 200, await mutateMySQL(b));
              if (b.type === "redis")
                return json(res, 200, await mutateRedis(b));
              if (b.type && b.type !== "sqlite")
                throw Error(
                  "显式写入目前仅支持 SQLite / PostgreSQL / MySQL / Redis SET",
                );
              return json(
                res,
                200,
                await mutateSQLiteBounded(
                  b.filename,
                  b.sql,
                  b.parameters || [],
                ),
              );
            }

            return json(
              res,
              200,
              b.type && b.type !== "sqlite"
                ? await queryRemoteDatabase(b)
                : await querySQLiteBounded(
                    b.filename,
                    b.sql,
                    b.parameters || [],
                  ),
            );
          }
          if (action === "dictionary-preview" && req.method === "POST") {
            const data = await body(req);
            return json(
              res,
              200,
              previewParameterImport(
                parseParameterImport(data.source, data.format),
                p.parameterDictionary || [],
              ),
            );
          }
          if (action === "sample" && req.method === "POST") {
            const b = await body(req);
            return json(res, 200, {
              sample: sampleProjectSchema(p, b.schema ?? {}),
            });
          }
          if (action === "environments" && req.method === "POST") {
            const b = await body(req);
            const allowedOperations = [
              "list_environments",
              "switch_environment",
              "create_environment",
              "update_environment",
              "delete_environment",
              "list_environment_servers",
              "create_environment_server",
              "update_environment_server",
              "delete_environment_server",
              "get_environment_variables",
              "upsert_environment_variable",
              "delete_environment_variable",
              "get_global_variables",
              "upsert_global_variable",
              "delete_global_variable",
            ];
            if (!allowedOperations.includes(b.operation))
              throw Error("环境操作不存在");
            const result = manageEnvironment(p, b.operation, b.arguments || {});
            if (
              !b.operation.startsWith("list_") &&
              !b.operation.startsWith("get_")
            )
              await store.save(p);
            return json(res, 200, { result, project: p });
          }
          if (action === "dynamic-preview" && req.method === "POST") {
            const b = await body(req);
            const context = debugEnvironment(
              p,
              b.environmentId,
              debugEnvironments,
            );
            return json(res, 200, {
              value: await resolveDynamicValue(
                b.spec,
                context.variables,
                b.functions || p.settings?.functions || [],
              ),
            });
          }
          if (action === "function-preview" && req.method === "POST") {
            const b = await body(req);
            return json(res, 200, await previewFunction(b.function, b.value));
          }
          if (action === "curl" && req.method === "POST") {
            const data = await body(req);
            const exportRequest =
              data.request?.scriptURLMode === "sdk"
                ? applySharedScripts(p, data.request)
                : data.request;
            assertSDKCurlDefinition(exportRequest);
            const context = debugEnvironment(
              p,
              data.environmentId,
              debugEnvironments,
            );
            return json(res, 200, {
              curl: toCurl(
                resolveServiceRequest(
                  p,
                  sdkCurlDefinition(
                    await resolveDynamicRequest(
                      applySharedAuth(
                        p,
                        applyGlobalParameters(p, exportRequest),
                      ),
                      context.variables,
                      p.settings?.functions || [],
                      interpolate,
                    ),
                  ),
                  context.environment.id,
                ),
              ),
            });
          }
          if (action === "execute" && req.method === "POST") {
            const b = await body(req),
              { controller, runId } = claimRun(b.runId);
            try {
              const context = debugEnvironment(
                p,
                b.environmentId,
                debugEnvironments,
              );
              const env = context.variables;
              const request = normalizeRequest(
                freezeServiceBinding(p, b.request),
              );
              const scoped = scopedExecution(
                store,
                p,
                context.environment.id,
                env,
              );
              const single = await runPlan(
                snapshotPlan({
                  name: request.name,
                  functions: b.functions || p.settings?.functions || [],
                  steps: [{ request }],
                }),
                env,
                executeRequest,
                {
                  ...scoped,
                  databaseQuery: (operation, signal) =>
                    databaseSessions.query(p.id, operation, signal),
                  cookieSession: projectCookieSession(
                    store,
                    p,
                    context.environment.id,
                  ),
                  signal: controller.signal,
                  prepareRequest: (request) =>
                    resolveServiceRequest(p, request, context.environment.id),
                },
              );
              const result = single.results[0];
              if (result?.response)
                publishDebugVariables(debugEnvironments, context.publication, {
                  fingerprint: JSON.stringify(
                    environmentVariables(p, context.environment.id),
                  ),
                  variables: structuredClone(single.variables),
                });
              if (!result) throw Error("请求已取消");
              await store.append(p.id, "history", {
                id: id(),
                createdAt: new Date().toISOString(),
                name: request.name,
                ...result,
                source: "manual",
                durationMs: single.durationMs,
              });
              return json(res, 200, {
                ...result.response,
                outcome: result.status,
                variableWrites: scoped.receipt(),
                assertions: result.assertions,
                extracted: { ...single.variables, ...result.extracted },
                logs: result.logs,
                subrequests: result.subrequests,
                visualization: result.visualization,
                scriptResponse: result.scriptResponse,
                scriptStage: result.scriptStage,
                scriptScope: result.scriptScope,
                scriptDiagnostics: result.scriptDiagnostics,
                error: result.error,
              });
            } finally {
              controllers.delete(runId);
            }
          }
          if (action === "cases" && req.method === "POST") {
            const data = await body(req);
            if (
              !p.requests.some(
                (request) =>
                  request.id === data.sourceRequestId && !request.deletedAt,
              )
            )
              throw Error("来源接口不存在");
            const item = snapshotCase({
              ...data,
              request: freezeServiceBinding(p, data.request),
              functions: data.functions || p.settings?.functions || [],
            });
            p.cases ??= [];
            const index = p.cases.findIndex(
              (existing) => existing.id === item.id,
            );
            if (index < 0) {
              if (p.cases.length >= 1000) throw Error("用例最多1000个");
              p.cases.push(item);
            } else p.cases[index] = item;
            await store.save(p);
            return json(res, 200, { item, project: p });
          }
          if (action === "plans" && req.method === "POST") {
            const b = await body(req);
            if (
              (b.projectConfigRevision ?? b.projectRevision) !== undefined &&
              (b.projectConfigRevision ?? b.projectRevision) !==
                (p.configRevision ?? p.revision)
            )
              throw Error("项目已有其他修改，请重新加载");
            const plan = versionPlan(
              p.plans.find((item) => item.id === b.id),
              { ...b, functions: b.functions || p.settings?.functions || [] },
              "manual",
              p,
            );
            const index = p.plans.findIndex((x) => x.id === plan.id);
            if (index < 0) p.plans.push(plan);
            else p.plans[index] = plan;
            await store.save(p);
            return json(res, 200, {
              ...plan,
              projectRevision: p.revision,
              projectConfigRevision: p.configRevision,
              projectFingerprint: p._diskFingerprint,
            });
          }
          if (action === "run" && req.method === "POST") {
            const b = await body(req),
              plan = p.plans.find((x) => x.id === b.planId);
            if (!plan) throw Error("计划不存在");
            const runId = b.runId || id();
            if (
              typeof runId !== "string" ||
              !/^[A-Za-z0-9_-]{1,100}$/.test(runId) ||
              controllers.has(runId)
            )
              throw Error("计划运行标识无效或正在使用");
            const controller = new AbortController();
            controllers.set(runId, controller);
            try {
              const environmentId = b.environmentId || plan.environmentId;
              const env = environmentVariables(p, environmentId);
              const run = await runPlan(plan, env, executeRequest, {
                executeGrpc: executePlanGrpc,
                grpcCredentials: b.grpcCredentials,
                executeProtocol: executePlanWire,
                protocolCredentials: b.protocolCredentials,
                executeSocketIO: (input, signal) =>
                  executeSocketIOFlow(input, signal, {
                    projectId: p.id,
                    sessions: socketioSessions,
                  }),
                socketioCredentials: b.socketioCredentials,
                ...scopedExecution(store, p, environmentId),
                databaseQuery: (operation, signal) =>
                  databaseSessions.query(p.id, operation, signal),
                cookieSession: projectCookieSession(store, p, environmentId),
                signal: controller.signal,
                prepareRequest: (request) =>
                  resolveServiceRequest(p, request, environmentId),
              });
              return json(
                res,
                200,
                await recordPlanRun(store, p.id, run, "manual"),
              );
            } finally {
              controllers.delete(runId);
            }
          }
          if (action === "load" && req.method === "POST") {
            const b = await body(req);
            const context = debugEnvironment(
              p,
              b.environmentId,
              debugEnvironments,
            );
            const { controller, runId } = claimRun(b.runId);
            try {
              return json(
                res,
                200,
                await runLoad(p, b.request, {
                  cookieState: await projectCookieSession(
                    store,
                    p,
                    context.environment.id,
                  ).inspect(),
                  mode: b.mode,
                  durationSeconds: b.durationSeconds,
                  dataCSV: b.dataCSV,
                  count: b.count,
                  concurrency: b.concurrency,
                  environmentId: context.environment.id,
                  variables: context.variables,
                  signal: controller.signal,
                }),
              );
            } finally {
              controllers.delete(runId);
            }
          }
        }
        return json(res, 404, { error: "API not found" });
      }
      const pathname = u.pathname === "/" ? "/index.html" : u.pathname;
      const file = path.resolve(publicDir, "." + pathname);
      if (!file.startsWith(publicDir))
        return json(res, 403, { error: "Path rejected" });
      const data = await readFile(file);
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'",
      );
      res.setHeader(
        "Content-Type",
        {
          ".html": "text/html; charset=utf-8",
          ".css": "text/css",
          ".js": "text/javascript",
          ".svg": "image/svg+xml",
        }[path.extname(file)] || "application/octet-stream",
      );
      res.end(data);
    } catch (e) {
      json(res, e.code === "ENOENT" ? 404 : 400, { error: e.message });
    }
  });
  server.on("close", () => {
    mcpHTTPSessions.advance({ dropSessions: true });
    protocolSessions.close();
    socketioSessions.close();
    oauth.close();
    oauth1.close();
    databaseSessions.close();
  });
  const listen = (listenPort) =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(listenPort, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  try {
    await listen(port);
  } catch (error) {
    if (
      error.code !== "EADDRINUSE" ||
      requestedPort !== 0 ||
      !persistedMCP?.remember
    )
      throw error;
    mcp.enabled = false;
    mcpToken = "";
    mcpWarning =
      "保存的本地端口被占用，已改用新端口并关闭MCP。请重新授权并复制连接配置。";
    await listen(0);
    await saveMCPConfig(path.resolve(root), {
      ...mcp,
      token: "",
      port: server.address().port,
    });
  }

  return {
    server,
    store,
    oauthAllowed: (url) => oauth.allowed(url) || oauth1.allowed(url),
    launchUrl: `http://127.0.0.1:${server.address().port}/#token=${token}`,
    token,
    url: `http://127.0.0.1:${server.address().port}`,
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await createApp();
  console.log(
    `Local API Workbench: ${app.launchUrl}\nData: ${path.resolve(process.env.LOCAL_API_DATA || ".local-api")}`,
  );
}
